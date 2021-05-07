import { confirmDialog } from '@/services/alertService';
import { KeyboardModifier } from '@/services/ioService';
import { Strings, StringUtils } from '@/strings';
import {
  UuidString,
  SNNote,
  NoteMutator,
  ContentType,
  SNTag,
} from '@standardnotes/snjs';
import {
  makeObservable,
  observable,
  action,
  computed,
  runInAction,
} from 'mobx';
import { RefObject } from 'preact';
import { WebApplication } from '../application';
import { Editor } from '../editor';

export class NotesState {
  lastSelectedNote: SNNote | undefined;
  selectedNotes: Record<UuidString, SNNote> = {};
  contextMenuOpen = false;
  contextMenuPosition: { top: number; left: number } = { top: 0, left: 0 };

  constructor(
    private application: WebApplication,
    private onActiveEditorChanged: () => Promise<void>,
    appEventListeners: (() => void)[]
  ) {
    makeObservable(this, {
      selectedNotes: observable,
      contextMenuOpen: observable,
      contextMenuPosition: observable,

      selectedNotesCount: computed,

      deleteNotesPermanently: action,
      selectNote: action,
      setArchiveSelectedNotes: action,
      setContextMenuOpen: action,
      setContextMenuPosition: action,
      setHideSelectedNotePreviews: action,
      setLockSelectedNotes: action,
      setPinSelectedNotes: action,
      setTrashSelectedNotes: action,
      unselectNotes: action,
    });

    appEventListeners.push(
      application.streamItems(ContentType.Note, (notes) => {
        runInAction(() => {
          for (const note of notes) {
            if (this.selectedNotes[note.uuid]) {
              this.selectedNotes[note.uuid] = note as SNNote;
            }
          }
        });
      })
    );
  }

  get activeEditor(): Editor | undefined {
    return this.application.editorGroup.editors[0];
  }

  get selectedNotesCount(): number {
    return Object.keys(this.selectedNotes).length;
  }

  async selectNotesRange(selectedNote: SNNote): Promise<void> {
    const notes = this.application.getDisplayableItems(
      ContentType.Note
    ) as SNNote[];
    const lastSelectedNoteIndex = notes.findIndex(
      (note) => note.uuid == this.lastSelectedNote?.uuid
    );
    const selectedNoteIndex = notes.findIndex(
      (note) => note.uuid == selectedNote.uuid
    );
    let protectedNotesAccessRequest: Promise<boolean>;
    let notesToSelect = [];

    if (selectedNoteIndex > lastSelectedNoteIndex) {
      notesToSelect = notes.slice(lastSelectedNoteIndex, selectedNoteIndex + 1);
    } else {
      notesToSelect = notes.slice(selectedNoteIndex, lastSelectedNoteIndex + 1);
    }

    await Promise.all(
      notesToSelect.map(async (note) => {
        const requestAccess =
          note.protected && this.application.hasProtectionSources();
        if (requestAccess) {
          if (!protectedNotesAccessRequest) {
            protectedNotesAccessRequest = this.application.authorizeNoteAccess(
              note
            );
          }
        }
        if (!requestAccess || (await protectedNotesAccessRequest)) {
          this.selectedNotes[note.uuid] = note;
        }
      })
    );

    this.lastSelectedNote = selectedNote;
  }

  async selectNote(uuid: UuidString): Promise<void> {
    const note = this.application.findItem(uuid) as SNNote;
    if (
      this.io.activeModifiers.has(
        KeyboardModifier.Meta || KeyboardModifier.Ctrl
      )
    ) {
      if (this.selectedNotes[uuid]) {
        delete this.selectedNotes[uuid];
      } else if (await this.application.authorizeNoteAccess(note)) {
        this.selectedNotes[uuid] = note;
        this.lastSelectedNote = note;
      }
    } else if (this.io.activeModifiers.has(KeyboardModifier.Shift)) {
      await this.selectNotesRange(note);
    } else {
      if (await this.application.authorizeNoteAccess(note)) {
        this.selectedNotes = {
          [uuid]: note,
        };
        await this.openEditor(uuid);
        this.lastSelectedNote = note;
      }
    }
  }

  private async openEditor(noteUuid: string): Promise<void> {
    if (this.activeEditor?.note?.uuid === noteUuid) {
      return;
    }

    const note = this.application.findItem(noteUuid) as SNNote | undefined;
    if (!note) {
      console.warn('Tried accessing a non-existant note of UUID ' + noteUuid);
      return;
    }

    if (!this.activeEditor) {
      this.application.editorGroup.createEditor(noteUuid);
    } else {
      this.activeEditor.setNote(note);
    }
    await this.onActiveEditorChanged();

    if (note.waitingForKey) {
      this.application.presentKeyRecoveryWizard();
    }
  }

  setContextMenuOpen(open: boolean): void {
    this.contextMenuOpen = open;
  }

  setContextMenuPosition(position: { top: number; left: number }): void {
    this.contextMenuPosition = position;
  }

  setHideSelectedNotePreviews(hide: boolean): void {
    this.application.changeItems<NoteMutator>(
      Object.keys(this.selectedNotes),
      (mutator) => {
        mutator.hidePreview = hide;
      },
      false
    );
  }

  setLockSelectedNotes(lock: boolean): void {
    this.application.changeItems<NoteMutator>(
      Object.keys(this.selectedNotes),
      (mutator) => {
        mutator.locked = lock;
      },
      false
    );
  }

  async setTrashSelectedNotes(
    trashed: boolean,
    trashButtonRef: RefObject<HTMLButtonElement>
  ): Promise<void> {
    if (trashed) {
      const notesDeleted = await this.deleteNotes(false);
      if (notesDeleted) {
        runInAction(() => {
          this.selectedNotes = {};
          this.contextMenuOpen = false;
        });
      } else {
        trashButtonRef.current?.focus();
      }
    } else {
      this.application.changeItems<NoteMutator>(
        Object.keys(this.selectedNotes),
        (mutator) => {
          mutator.trashed = trashed;
        },
        false
      );
      runInAction(() => {
        this.selectedNotes = {};
        this.contextMenuOpen = false;
      });
    }
  }

  async deleteNotesPermanently(): Promise<void> {
    await this.deleteNotes(true);
  }

  async deleteNotes(permanently: boolean): Promise<boolean> {
    if (Object.values(this.selectedNotes).some((note) => note.locked)) {
      const text = StringUtils.deleteLockedNotesAttempt(
        this.selectedNotesCount
      );
      this.application.alertService.alert(text);
      return false;
    }

    const title = Strings.trashNotesTitle;
    let noteTitle = undefined;
    if (this.selectedNotesCount === 1) {
      const selectedNote = Object.values(this.selectedNotes)[0];
      noteTitle = selectedNote.safeTitle().length
        ? `'${selectedNote.title}'`
        : 'this note';
    }
    const text = StringUtils.deleteNotes(
      permanently,
      this.selectedNotesCount,
      noteTitle
    );

    if (
      await confirmDialog({
        title,
        text,
        confirmButtonStyle: 'danger',
      })
    ) {
      if (permanently) {
        for (const note of Object.values(this.selectedNotes)) {
          await this.application.deleteItem(note);
        }
      } else {
        this.application.changeItems<NoteMutator>(
          Object.keys(this.selectedNotes),
          (mutator) => {
            mutator.trashed = true;
          },
          false
        );
      }
      return true;
    }

    return false;
  }

  setPinSelectedNotes(pinned: boolean): void {
    this.application.changeItems<NoteMutator>(
      Object.keys(this.selectedNotes),
      (mutator) => {
        mutator.pinned = pinned;
      },
      false
    );
  }

  async setArchiveSelectedNotes(archived: boolean): Promise<void> {
    if (Object.values(this.selectedNotes).some((note) => note.locked)) {
      this.application.alertService.alert(
        StringUtils.archiveLockedNotesAttempt(archived, this.selectedNotesCount)
      );
      return;
    }
    this.application.changeItems<NoteMutator>(
      Object.keys(this.selectedNotes),
      (mutator) => {
        mutator.archived = archived;
      }
    );
    runInAction(() => {
      this.selectedNotes = {};
      this.contextMenuOpen = false;
    });
  }

  unselectNotes(): void {
    this.selectedNotes = {};
  }

  private get io() {
    return this.application.io;
  }
}
