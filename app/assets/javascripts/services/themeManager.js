import _ from 'lodash';
import { ContentTypes, StorageValueModes, EncryptionIntents, PureService } from 'snjs';
import { AppStateEvents } from '@/state';

const CACHED_THEMES_KEY = 'cachedThemes';

export class ThemeManager extends PureService {
  /* @ngInject */
  constructor(
    application,
    appState,
    desktopManager,
  ) {
    super();
    this.application = application;
    this.appState = appState;
    this.desktopManager = desktopManager;
    this.activeThemes = [];
    this.registerObservers();
    application.onStart(() => {
      if (!desktopManager.isDesktop) {
        this.activateCachedThemes();
      }
    });
    this.unsubState = appState.addObserver((eventName, data) => {
      if (eventName === AppStateEvents.DesktopExtsReady) {
        this.activateCachedThemes();
      }
    });
  }

  /** @override */
  async deinit() {
    super.deinit();
    this.unsubState();
  }

  async activateCachedThemes() {
    const cachedThemes = await this.getCachedThemes();
    const writeToCache = false;
    for (const theme of cachedThemes) {
      this.activateTheme(theme, writeToCache);
    }
  }

  registerObservers() {
    this.desktopManager.registerUpdateObserver((component) => {
      // Reload theme if active
      if (component.active && component.isTheme()) {
        this.deactivateTheme(component);
        setTimeout(() => {
          this.activateTheme(component);
        }, 10);
      }
    });

    this.application.componentManager.registerHandler({
      identifier: 'themeManager',
      areas: ['themes'],
      activationHandler: (component) => {
        if (component.active) {
          this.activateTheme(component);
        } else {
          this.deactivateTheme(component);
        }
      }
    });
  }

  hasActiveTheme() {
    return this.application.componentManager.getActiveThemes().length > 0;
  }

  deactivateAllThemes() {
    var activeThemes = this.application.componentManager.getActiveThemes();
    for (var theme of activeThemes) {
      if (theme) {
        this.application.componentManager.deactivateComponent(theme);
      }
    }

    this.decacheThemes();
  }

  activateTheme(theme, writeToCache = true) {
    if (_.find(this.activeThemes, { uuid: theme.uuid })) {
      return;
    }
    this.activeThemes.push(theme);
    const url = this.application.componentManager.urlForComponent(theme);
    const link = document.createElement('link');
    link.href = url;
    link.type = 'text/css';
    link.rel = 'stylesheet';
    link.media = 'screen,print';
    link.id = theme.uuid;
    document.getElementsByTagName('head')[0].appendChild(link);
    if (writeToCache) {
      this.cacheThemes();
    }
  }

  deactivateTheme(theme) {
    const element = document.getElementById(theme.uuid);
    if (element) {
      element.disabled = true;
      element.parentNode.removeChild(element);
    }

    _.remove(this.activeThemes, { uuid: theme.uuid });

    this.cacheThemes();
  }

  async cacheThemes() {
    const mapped = await Promise.all(this.activeThemes.map(async (theme) => {
      const payload = theme.payloadRepresentation();
      const processedPayload = await this.application.protocolService.payloadByEncryptingPayload({
        payload: payload,
        intent: EncryptionIntents.LocalStorageDecrypted
      });
      return processedPayload;
    }));
    return this.application.setValue(
      CACHED_THEMES_KEY,
      mapped,
      StorageValueModes.Nonwrapped
    );
  }

  async decacheThemes() {
    return this.application.removeValue(
      CACHED_THEMES_KEY,
      StorageValueModes.Nonwrapped
    );
  }

  async getCachedThemes() {
    const cachedThemes = await this.application.getValue(
      CACHED_THEMES_KEY,
      StorageValueModes.Nonwrapped
    );
    if (cachedThemes) {
      const themes = [];
      for(const cachedTheme of cachedThemes) {
        const theme = await this.application.createItem({
          contentType: ContentTypes.Theme,
          content: cachedTheme.content
        });
        themes.push(theme);
      }
      return themes;
    } else {
      return [];
    }
  }
}
