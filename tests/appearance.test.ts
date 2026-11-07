import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  addCspHash,
  appearanceScript,
  extractSettingsAppearance,
  injectAppearanceSync,
  mergeAppearanceProfile,
  mergeSettingsAppearance,
  normalizeAppearanceProfile,
  parseAppearanceProfile,
  sha256Base64,
  type AppearanceProfile,
  type AppearanceScriptOptions,
} from '../src/core/appearance';

class MemoryStorage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
}

interface ScriptRun {
  sends: string[];
  events: FakeEventSource[];
  reloads: number;
  dispatched: StorageEventLike[];
  clientSource: string;
}

interface StorageEventLike {
  key: string;
  newValue: string | null;
}

class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | undefined;

  constructor(readonly url: string) {
    sources.push(this);
  }
}

const sources: FakeEventSource[] = [];

function runScript(storage: MemoryStorage, profile: AppearanceProfile, options: AppearanceScriptOptions = {}): ScriptRun {
  const sends: string[] = [];
  const run: ScriptRun = { sends, events: sources, reloads: 0, dispatched: [], clientSource: '' };
  sources.length = 0;
  const context = {
    localStorage: storage,
    fetch: (_url: string, init: { body: string; headers?: Record<string, string> }) => {
      sends.push(init.body);
      run.clientSource = init.headers?.['x-oc-appearance-source'] ?? run.clientSource;
      return { catch: () => undefined };
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    clearTimeout: () => undefined,
    EventSource: FakeEventSource,
    StorageEvent: class {
      constructor(_type: string, init: { key: string; newValue: string | null }) {
        run.dispatched.push({ key: init.key, newValue: init.newValue });
      }
    },
    window: {
      addEventListener: () => undefined,
      dispatchEvent: () => true,
    },
    document: {
      visibilityState: 'visible',
      hasFocus: () => false,
      addEventListener: () => undefined,
    },
    location: {
      href: 'http://127.0.0.1:1/',
      reload: () => {
        run.reloads++;
      },
    },
  };
  runInNewContext(appearanceScript(profile, options), context);
  return run;
}

describe('appearance profile', () => {
  it('keeps only known localStorage keys', () => {
    const profile = normalizeAppearanceProfile({
      values: { 'opencode-theme-id': 'rosepine', 'opencode-color-scheme': 'dark', evil: 'x' },
      settings: { fontSize: 15 },
    });
    expect(profile.values).toEqual({ 'opencode-theme-id': 'rosepine', 'opencode-color-scheme': 'dark' });
    expect(profile.settings).toEqual({ fontSize: 15 });
  });

  it('keeps only known preference keys', () => {
    const profile = normalizeAppearanceProfile({
      preferences: {
        values: { 'opencode.global.dat:language': 'ru', evil: 'x' },
        sections: { keybinds: { save: 'ctrl+s' }, permissions: { autoApprove: true }, evil: {} },
      },
    });
    expect(profile.preferences?.values).toEqual({ 'opencode.global.dat:language': 'ru' });
    expect(profile.preferences?.sections).toEqual({ keybinds: { save: 'ctrl+s' } });
  });

  it('merges only the groups the client changed', () => {
    const current = normalizeAppearanceProfile({
      values: { 'opencode-theme-id': 'rosepine' },
      settings: { fontSize: 15 },
      preferences: { sections: { keybinds: { save: 'ctrl+s' } } },
    });
    const incoming = normalizeAppearanceProfile({
      values: { 'opencode-theme-id': 'dracula' },
      settings: { fontSize: 18 },
      preferences: { sections: { keybinds: { save: 'ctrl+k' } } },
    });

    const preferencesOnly = mergeAppearanceProfile(current, incoming, ['preferences'], true);
    expect(preferencesOnly.values['opencode-theme-id']).toBe('rosepine');
    expect(preferencesOnly.settings).toEqual({ fontSize: 15 });
    expect(preferencesOnly.preferences?.sections.keybinds).toEqual({ save: 'ctrl+k' });

    const themeOnly = mergeAppearanceProfile(current, incoming, ['values'], true);
    expect(themeOnly.values['opencode-theme-id']).toBe('dracula');
    expect(themeOnly.settings).toEqual({ fontSize: 15 });
    expect(themeOnly.preferences?.sections.keybinds).toEqual({ save: 'ctrl+s' });
  });

  it('builds a reset profile and preserves its timestamp', () => {
    const reset = normalizeAppearanceProfile({ resetAt: 123 });
    expect(reset.resetAt).toBe(123);
    expect(reset.values).toEqual({});
    expect(reset.settings).toEqual({});
  });

  it('falls back to an empty profile for malformed files', () => {
    const empty = { values: {}, settings: {}, preferences: { values: {}, sections: {} } };
    expect(parseAppearanceProfile('not json')).toEqual(empty);
    expect(parseAppearanceProfile(null)).toEqual(empty);
  });

  it('merges only the appearance subtree of settings.v3', () => {
    const raw = JSON.stringify({ permissions: { autoApprove: true }, appearance: { fontSize: 12 } });
    expect(extractSettingsAppearance(raw)).toEqual({ fontSize: 12 });
    const merged = JSON.parse(mergeSettingsAppearance(raw, { fontSize: 15, reduceMotion: 'on' }));
    expect(merged.permissions).toEqual({ autoApprove: true });
    expect(merged.appearance).toEqual({ fontSize: 15, reduceMotion: 'on' });
  });
});

describe('CSP', () => {
  it('adds the injected script hash to script-src only', () => {
    const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-old'; style-src 'self'";
    const result = addCspHash(csp, 'abc');
    expect(result).toContain("script-src 'self' 'wasm-unsafe-eval' 'sha256-old' 'sha256-abc';");
    expect(result.match(/'sha256-abc'/g)).toHaveLength(1);
  });

  it('creates a script-src directive when the policy has none', () => {
    expect(addCspHash("default-src 'self'", 'abc')).toBe("default-src 'self'; script-src 'sha256-abc'");
  });
});

describe('injectAppearanceSync', () => {
  it('inserts the script before the theme preload and returns its hash', () => {
    const html = '<html><head><script id="oc-theme-preload-script">x</script></head></html>';
    const result = injectAppearanceSync(html, { values: { 'opencode-theme-id': 'rosepine' }, settings: {} });
    const script = /<script id="oc-appearance-sync">([\s\S]*?)<\/script>/.exec(result.html);
    expect(script).not.toBeNull();
    expect(sha256Base64(script![1])).toBe(result.hash);
    expect(result.html.indexOf('oc-appearance-sync')).toBeLessThan(result.html.indexOf('oc-theme-preload-script'));
  });

  it('escapes closing script tags in profile values', () => {
    const result = injectAppearanceSync(
      '<html><head></head></html>',
      { values: { 'opencode-theme-id': '</script><evil>' }, settings: {} },
    );
    expect(result.html).not.toContain('</script><evil>');
    expect(result.html).toContain('\\u003c/script>\\u003cevil>');
  });
});

describe('injected appearance script', () => {
  it('applies the shared profile without sending it back', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode-theme-id', 'oc-2');
    storage.setItem(
      'settings.v3',
      JSON.stringify({ permissions: { autoApprove: true }, appearance: { fontSize: 12 } }),
    );

    const sends = runScript(storage, {
      values: { 'opencode-theme-id': 'rosepine', 'opencode-color-scheme': 'dark' },
      settings: { fontSize: 15, reduceMotion: 'on' },
    });

    expect(storage.getItem('opencode-theme-id')).toBe('rosepine');
    expect(storage.getItem('opencode-color-scheme')).toBe('dark');
    expect(JSON.parse(storage.getItem('settings.v3')!)).toEqual({
      permissions: { autoApprove: true },
      appearance: { fontSize: 15, reduceMotion: 'on' },
    });
    expect(sends.sends).toHaveLength(0);
  });

  it('seeds an empty shared profile from the current window', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode-theme-id', 'rosepine');
    const sends = runScript(storage, { values: {}, settings: {} });
    expect(sends.sends).toHaveLength(1);
    expect(JSON.parse(sends.sends[0])).toMatchObject({ values: { 'opencode-theme-id': 'rosepine' } });
  });

  it('seeds keys the shared profile does not have yet', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode-theme-id', 'rosepine');
    const sends = runScript(storage, {
      values: { 'opencode-color-scheme': 'dark' },
      settings: { fontSize: 15 },
    });
    expect(sends.sends).toHaveLength(1);
    expect(JSON.parse(sends.sends[0])).toMatchObject({
      values: { 'opencode-theme-id': 'rosepine', 'opencode-color-scheme': 'dark' },
      settings: { fontSize: 15 },
    });
  });

  it('applies live theme updates from another window', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode-theme-id', 'oc-2');
    const run = runScript(storage, { values: { 'opencode-theme-id': 'oc-2' }, settings: {} });

    expect(run.events).toHaveLength(1);
    run.events[0].onmessage!({
      data: JSON.stringify({
        source: 'another-window',
        profile: { values: { 'opencode-theme-id': 'rosepine' }, settings: { fontSize: 15 } },
      }),
    });

    expect(storage.getItem('opencode-theme-id')).toBe('rosepine');
    expect(run.dispatched).toContainEqual({ key: 'opencode-theme-id', newValue: 'rosepine' });
    expect(run.reloads).toBe(1);
    expect(run.sends).toHaveLength(0);
  });

  it('ignores its own SSE event', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode-theme-id', 'oc-2');
    const run = runScript(storage, { values: {}, settings: {} });
    // The initial seed captures the generated client id.
    expect(run.clientSource).not.toBe('');

    run.events[0].onmessage!({
      data: JSON.stringify({
        source: run.clientSource,
        profile: { values: { 'opencode-theme-id': 'rosepine' }, settings: {} },
      }),
    });

    expect(storage.getItem('opencode-theme-id')).toBe('oc-2');
    expect(run.reloads).toBe(0);
  });

  it('captures theme changes but ignores unrelated settings writes', () => {
    const storage = new MemoryStorage();
    storage.setItem('settings.v3', JSON.stringify({ appearance: { fontSize: 15 } }));
    const sends = runScript(storage, { values: { 'opencode-theme-id': 'rosepine' }, settings: { fontSize: 15 } });

    const stale = JSON.parse(storage.getItem('settings.v3')!);
    stale.permissions = { autoApprove: true };
    storage.setItem('settings.v3', JSON.stringify(stale));
    expect(sends.sends).toHaveLength(0);

    storage.setItem('opencode-theme-id', 'dracula');
    expect(sends.sends).toHaveLength(1);
    expect(JSON.parse(sends.sends[0])).toMatchObject({ values: { 'opencode-theme-id': 'dracula' } });

    stale.appearance.fontSize = 18;
    storage.setItem('settings.v3', JSON.stringify(stale));
    expect(sends.sends).toHaveLength(2);
    expect(JSON.parse(sends.sends[1])).toMatchObject({ settings: { fontSize: 18 } });
  });

  it('applies and captures preferences when enabled', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode.global.dat:language', JSON.stringify({ locale: 'en' }));
    storage.setItem(
      'settings.v3',
      JSON.stringify({ keybinds: { save: 'ctrl+s' }, permissions: { autoApprove: true } }),
    );

    const run = runScript(
      storage,
      {
        values: { 'opencode-theme-id': 'rosepine' },
        settings: {},
        preferences: {
          values: { 'opencode.global.dat:language': JSON.stringify({ locale: 'ru' }) },
          sections: { keybinds: { save: 'ctrl+shift+s' } },
        },
      },
      { syncPreferences: true },
    );

    expect(storage.getItem('opencode.global.dat:language')).toBe(JSON.stringify({ locale: 'ru' }));
    const settings = JSON.parse(storage.getItem('settings.v3')!);
    expect(settings.keybinds).toEqual({ save: 'ctrl+shift+s' });
    expect(settings.permissions).toEqual({ autoApprove: true });
    expect(run.sends).toHaveLength(0);

    settings.permissions = { autoApprove: false };
    storage.setItem('settings.v3', JSON.stringify(settings));
    expect(run.sends).toHaveLength(0);

    storage.setItem('opencode.global.dat:language', JSON.stringify({ locale: 'de' }));
    expect(run.sends).toHaveLength(1);
    const sent = JSON.parse(run.sends[0]);
    expect(sent.preferences.values).toMatchObject({
      'opencode.global.dat:language': JSON.stringify({ locale: 'de' }),
    });
    expect(sent.changed).toEqual(['preferences']);
  });

  it('ignores preferences when disabled', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode.global.dat:language', JSON.stringify({ locale: 'en' }));
    const run = runScript(storage, {
      values: { 'opencode-theme-id': 'rosepine' },
      settings: {},
      preferences: {
        values: { 'opencode.global.dat:language': JSON.stringify({ locale: 'ru' }) },
        sections: { keybinds: { save: 'ctrl+shift+s' } },
      },
    });

    expect(storage.getItem('opencode.global.dat:language')).toBe(JSON.stringify({ locale: 'en' }));
    storage.setItem('opencode.global.dat:language', JSON.stringify({ locale: 'de' }));
    expect(run.sends).toHaveLength(0);
  });

  it('reloads on a remote preference change', () => {
    const storage = new MemoryStorage();
    const run = runScript(
      storage,
      { values: { 'opencode-theme-id': 'rosepine' }, settings: {} },
      { syncPreferences: true },
    );
    run.events[0].onmessage!({
      data: JSON.stringify({
        source: 'other',
        profile: {
          values: {},
          settings: {},
          preferences: { values: {}, sections: { keybinds: { save: 'ctrl+k' } } },
        },
      }),
    });

    const settings = JSON.parse(storage.getItem('settings.v3') ?? '{}');
    expect(settings.keybinds).toEqual({ save: 'ctrl+k' });
    expect(run.reloads).toBe(1);
  });

  it('clears synced state on a newer reset marker', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode-theme-id', 'rosepine');
    storage.setItem('opencode-theme-css-dark', 'css');
    storage.setItem('opencode.global.dat:language', 'ru');
    storage.setItem(
      'settings.v3',
      JSON.stringify({
        appearance: { fontSize: 15 },
        keybinds: { save: 'ctrl+s' },
        permissions: { autoApprove: true },
      }),
    );

    const run = runScript(
      storage,
      { values: {}, settings: {}, preferences: { values: {}, sections: {} }, resetAt: 100 },
      { syncPreferences: true },
    );

    expect(storage.getItem('opencode-theme-id')).toBeNull();
    expect(storage.getItem('opencode-theme-css-dark')).toBeNull();
    expect(storage.getItem('opencode.global.dat:language')).toBeNull();
    const settings = JSON.parse(storage.getItem('settings.v3')!);
    expect(settings.appearance).toBeUndefined();
    expect(settings.keybinds).toBeUndefined();
    expect(settings.permissions).toEqual({ autoApprove: true });
    expect(storage.getItem('oc-appearance-reset')).toBe('100');
    expect(run.sends).toHaveLength(0);
  });

  it('resets and reloads on a remote reset event', () => {
    const storage = new MemoryStorage();
    const run = runScript(storage, { values: { 'opencode-theme-id': 'rosepine' }, settings: {} });
    expect(storage.getItem('opencode-theme-id')).toBe('rosepine');

    run.events[0].onmessage!({
      data: JSON.stringify({
        source: 'other',
        profile: { values: {}, settings: {}, preferences: { values: {}, sections: {} }, resetAt: 100 },
      }),
    });

    expect(storage.getItem('opencode-theme-id')).toBeNull();
    expect(storage.getItem('oc-appearance-reset')).toBeNull();
    expect(run.reloads).toBe(1);
  });

  it('finishes the reset on the reloaded page', () => {
    const storage = new MemoryStorage();
    storage.setItem('opencode-theme-id', 'rosepine');
    storage.setItem('settings.v3', JSON.stringify({ appearance: { fontSize: 17 } }));

    const run = runScript(
      storage,
      { values: {}, settings: {}, preferences: { values: {}, sections: {} }, resetAt: 100 },
      { syncPreferences: true },
    );

    expect(storage.getItem('opencode-theme-id')).toBeNull();
    expect(storage.getItem('oc-appearance-reset')).toBe('100');
    expect(JSON.parse(storage.getItem('settings.v3')!).appearance).toBeUndefined();
    expect(run.sends).toHaveLength(0);
  });
});
