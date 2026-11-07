/**
 * Shared UI profile for the OpenCode web UI.
 *
 * The web UI keeps its theme in `localStorage`, scoped to the proxy origin
 * (`http://127.0.0.1:<port>`). This extension gives every workspace its own
 * port, so each workspace gets a fresh `localStorage` and the theme has to be
 * chosen again. The proxy injects a shared profile into the OpenCode index page
 * before the app boots, captures later changes and streams updates over SSE.
 *
 * Kept free of `vscode` so the HTML/JS can be exercised in unit tests.
 */
import { createHash } from 'node:crypto';

export const APPEARANCE_ENDPOINT = '/__oc-appearance';

/** The `settings.v3` localStorage key used by the OpenCode web UI. */
export const SETTINGS_STORAGE_KEY = 'settings.v3';

/** Marks the last appearance reset applied by this origin. */
export const RESET_MARKER_KEY = 'oc-appearance-reset';

/** Direct localStorage keys that make up the web UI theme. */
export const APPEARANCE_STORAGE_KEYS = ['opencode-theme-id', 'opencode-color-scheme'] as const;

/** Theme caches are cleared on reset but are not synchronised. */
export const THEME_CACHE_KEYS = ['opencode-theme-css-light', 'opencode-theme-css-dark'] as const;

/** Optional direct localStorage keys (language and motion tuning). */
export const PREFERENCE_STORAGE_KEYS = ['opencode.global.dat:language', 'opencode.motion.v1'] as const;

/** Optional top-level `settings.v3` sections. Permissions and workspaces stay local. */
export const PREFERENCE_SETTINGS_KEYS = ['general', 'keybinds', 'notifications', 'sounds'] as const;

export interface AppearanceProfile {
  /** Theme and color scheme. */
  values: Record<string, string>;
  /** The `appearance` subtree of the `settings.v3` JSON value. */
  settings: Record<string, unknown>;
  /** Optional preferences, only applied when `syncPreferences` is enabled. */
  preferences?: {
    values: Record<string, string>;
    sections: Record<string, unknown>;
  };
  /** Unix ms of the last "reset shared appearance" request. */
  resetAt?: number;
}

export interface AppearanceScriptOptions {
  endpoint?: string;
  syncPreferences?: boolean;
}

export function emptyAppearanceProfile(): AppearanceProfile {
  return { values: {}, settings: {}, preferences: { values: {}, sections: {} } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Keep only known keys so a proxy POST cannot inject arbitrary localStorage. */
export function normalizeAppearanceProfile(input: unknown): AppearanceProfile {
  const source = isRecord(input) ? input : {};
  const values: Record<string, string> = {};
  const rawValues = isRecord(source.values) ? source.values : {};
  for (const key of APPEARANCE_STORAGE_KEYS) {
    const value = rawValues[key];
    if (typeof value === 'string') values[key] = value;
  }

  const preferencesSource = isRecord(source.preferences) ? source.preferences : {};
  const preferenceValues: Record<string, string> = {};
  const rawPreferenceValues = isRecord(preferencesSource.values) ? preferencesSource.values : {};
  for (const key of PREFERENCE_STORAGE_KEYS) {
    const value = rawPreferenceValues[key];
    if (typeof value === 'string') preferenceValues[key] = value;
  }
  const sections: Record<string, unknown> = {};
  const rawSections = isRecord(preferencesSource.sections) ? preferencesSource.sections : {};
  for (const key of PREFERENCE_SETTINGS_KEYS) {
    const value = rawSections[key];
    if (isRecord(value)) sections[key] = value;
  }

  const profile: AppearanceProfile = {
    values,
    settings: isRecord(source.settings) ? source.settings : {},
    preferences: { values: preferenceValues, sections },
  };
  if (typeof source.resetAt === 'number' && Number.isFinite(source.resetAt)) profile.resetAt = source.resetAt;
  return profile;
}

/** Parse a profile file; malformed content becomes an empty profile. */
export function parseAppearanceProfile(raw: string | null | undefined): AppearanceProfile {
  if (!raw) return emptyAppearanceProfile();
  try {
    return normalizeAppearanceProfile(JSON.parse(raw));
  } catch {
    return emptyAppearanceProfile();
  }
}

/**
 * Merge a client write into the shared profile. `changed` is sent by the
 * injected script so a stale window changing one group cannot overwrite
 * another group with old local values.
 */
export function mergeAppearanceProfile(
  current: AppearanceProfile,
  incoming: AppearanceProfile,
  changed: readonly string[] = ['all'],
  syncPreferences = false,
): AppearanceProfile {
  const all = changed.includes('all') || changed.length === 0;
  const profile: AppearanceProfile = {
    values: all || changed.includes('values') ? { ...current.values, ...incoming.values } : current.values,
    settings: all || changed.includes('settings') ? { ...current.settings, ...incoming.settings } : current.settings,
    preferences:
      syncPreferences && (all || changed.includes('preferences'))
        ? {
            values: { ...(current.preferences?.values ?? {}), ...(incoming.preferences?.values ?? {}) },
            sections: { ...(current.preferences?.sections ?? {}), ...(incoming.preferences?.sections ?? {}) },
          }
        : current.preferences,
  };
  if (current.resetAt !== undefined) profile.resetAt = current.resetAt;
  return profile;
}

export function createResetProfile(now = Date.now()): AppearanceProfile {
  return { values: {}, settings: {}, preferences: { values: {}, sections: {} }, resetAt: now };
}

export function hasProfileContent(profile: AppearanceProfile): boolean {
  return (
    Object.keys(profile.values).length > 0 ||
    Object.keys(profile.settings).length > 0 ||
    Object.keys(profile.preferences?.values ?? {}).length > 0 ||
    Object.keys(profile.preferences?.sections ?? {}).length > 0 ||
    profile.resetAt !== undefined
  );
}

/** Extract the `appearance` object from a raw `settings.v3` value. */
export function extractSettingsAppearance(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) && isRecord(parsed.appearance) ? parsed.appearance : {};
  } catch {
    return {};
  }
}

/** Merge synced appearance values into a raw `settings.v3` value. */
export function mergeSettingsAppearance(
  raw: string | null | undefined,
  appearance: Record<string, unknown>,
): string {
  let settings: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) settings = parsed;
    } catch {
      // keep a fresh object
    }
  }
  const current = isRecord(settings.appearance) ? settings.appearance : {};
  settings.appearance = { ...current, ...appearance };
  return JSON.stringify(settings);
}

export function sha256Base64(value: string): string {
  return createHash('sha256').update(value).digest('base64');
}

/** JSON embedded in an inline script: never allow a literal </script>. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The script inserted before `oc-theme-preload-script`.
 *
 * It applies the shared profile synchronously (so there is no theme flash),
 * then patches localStorage so the first change in any window becomes the new
 * shared profile. A `settings.v3` write is only forwarded when the synced
 * subtrees actually changed, which avoids stale windows overwriting fresh
 * values with unrelated setting changes.
 *
 * SSE applies theme/color-scheme changes live (the web UI listens for storage
 * events). Fonts and other settings require a reload because the settings
 * store has no cross-document listener; the script reloads itself when it is
 * not focused, or on its next blur.
 */
export function appearanceScript(profile: AppearanceProfile, options: AppearanceScriptOptions = {}): string {
  const endpoint = options.endpoint ?? APPEARANCE_ENDPOINT;
  const syncPreferences = options.syncPreferences === true;
  return `(function(){
  var PROFILE=${jsonForScript(profile)};
  var THEME_KEYS=${jsonForScript(APPEARANCE_STORAGE_KEYS)};
  var THEME_CACHE=${jsonForScript(THEME_CACHE_KEYS)};
  var PREF_KEYS=${jsonForScript(PREFERENCE_STORAGE_KEYS)};
  var PREF_SECTIONS=${jsonForScript(PREFERENCE_SETTINGS_KEYS)};
  var SETTINGS_KEY=${JSON.stringify(SETTINGS_STORAGE_KEY)};
  var RESET_MARKER=${JSON.stringify(RESET_MARKER_KEY)};
  var SYNC_PREFERENCES=${syncPreferences ? 'true' : 'false'};
  var ENDPOINT=${JSON.stringify(endpoint)};
  var CLIENT_ID=Math.random().toString(36).slice(2)+Date.now().toString(36);
  var applyingRemote=false;
  function isObject(v){return !!v&&typeof v==='object'&&!Array.isArray(v)}
  function parse(v){try{return v?JSON.parse(v):null}catch(e){return null}}
  function settingsObject(){var s=parse(localStorage.getItem(SETTINGS_KEY));return isObject(s)?s:{}}
  function readSection(key){var s=settingsObject();return isObject(s[key])?s[key]:{}}
  function readThemeValues(){var values={};for(var i=0;i<THEME_KEYS.length;i++){var v=localStorage.getItem(THEME_KEYS[i]);if(v!==null)values[THEME_KEYS[i]]=v}return values}
  function readPreferenceValues(){var values={};if(!SYNC_PREFERENCES)return values;for(var i=0;i<PREF_KEYS.length;i++){var v=localStorage.getItem(PREF_KEYS[i]);if(v!==null)values[PREF_KEYS[i]]=v}return values}
  function readPreferenceSections(){var sections={};if(!SYNC_PREFERENCES)return sections;for(var i=0;i<PREF_SECTIONS.length;i++){var v=readSection(PREF_SECTIONS[i]);if(Object.keys(v).length>0)sections[PREF_SECTIONS[i]]=v}return sections}
  function read(){return {values:readThemeValues(),settings:readSection('appearance'),preferences:{values:readPreferenceValues(),sections:readPreferenceSections()}}}
  function applyValues(values){
    var changed=false;
    if(!isObject(values))return false;
    for(var k in values){if(Object.prototype.hasOwnProperty.call(values,k)&&localStorage.getItem(k)!==values[k]){localStorage.setItem(k,values[k]);changed=true}}
    return changed;
  }
  function mergeSection(key,patch){
    if(!isObject(patch)||Object.keys(patch).length===0)return false;
    var s=settingsObject();
    var before=isObject(s[key])?s[key]:{};
    var merged={};
    for(var k in before){merged[k]=before[k]}
    for(var k2 in patch){merged[k2]=patch[k2]}
    if(JSON.stringify(before)===JSON.stringify(merged))return false;
    s[key]=merged;
    localStorage.setItem(SETTINGS_KEY,JSON.stringify(s));
    return true;
  }
  function applyProfile(p){
    var themeChanged=applyValues(p.values);
    var settingsChanged=mergeSection('appearance',p.settings);
    var preferencesChanged=false;
    if(SYNC_PREFERENCES&&isObject(p.preferences)){
      if(applyValues(p.preferences.values))preferencesChanged=true;
      var sections=p.preferences.sections;
      if(isObject(sections)){for(var i=0;i<PREF_SECTIONS.length;i++){if(mergeSection(PREF_SECTIONS[i],sections[PREF_SECTIONS[i]]))preferencesChanged=true}}
    }
    return {theme:themeChanged,settings:settingsChanged||preferencesChanged};
  }
  function clearSynced(){
    for(var i=0;i<THEME_KEYS.length;i++)localStorage.removeItem(THEME_KEYS[i]);
    for(var j=0;j<THEME_CACHE.length;j++)localStorage.removeItem(THEME_CACHE[j]);
    var s=settingsObject();
    delete s.appearance;
    if(SYNC_PREFERENCES){
      for(var k=0;k<PREF_KEYS.length;k++)localStorage.removeItem(PREF_KEYS[k]);
      for(var m=0;m<PREF_SECTIONS.length;m++)delete s[PREF_SECTIONS[m]];
    }
    localStorage.setItem(SETTINGS_KEY,JSON.stringify(s));
  }
  function resetMarker(){return Number(localStorage.getItem(RESET_MARKER)||0)||0}
  function needsReset(p){return isObject(p)&&!!p.resetAt&&p.resetAt>resetMarker()}
  function markReset(p){localStorage.setItem(RESET_MARKER,String(p.resetAt))}
  if(needsReset(PROFILE)){clearSynced();markReset(PROFILE)}
  applyProfile(PROFILE);
  var settingsBefore=JSON.stringify(readSection('appearance'));
  var sectionsBefore=JSON.stringify(readPreferenceSections());
  var themeBefore=readThemeValues();
  var prefBefore=readPreferenceValues();
  var lastSent=JSON.stringify(read());
  var pendingGroups={};
  var timer;
  function send(force){
    var profile=read();
    var body=JSON.stringify(profile);
    if(!force&&body===lastSent){pendingGroups={};return}
    lastSent=body;
    var groups=Object.keys(pendingGroups);
    if(groups.length===0)groups=['all'];
    pendingGroups={};
    var payload=JSON.stringify({values:profile.values,settings:profile.settings,preferences:profile.preferences,changed:groups});
    try{fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json','x-oc-appearance':'1','x-oc-appearance-source':CLIENT_ID},body:payload}).catch(function(){})}catch(e){}
  }
  function schedule(force,groups){
    if(groups)for(var i=0;i<groups.length;i++)pendingGroups[groups[i]]=true;
    clearTimeout(timer);
    timer=setTimeout(function(){send(force)},150);
  }
  function snapshots(){
    settingsBefore=JSON.stringify(readSection('appearance'));
    sectionsBefore=JSON.stringify(readPreferenceSections());
    themeBefore=readThemeValues();
    prefBefore=readPreferenceValues();
    lastSent=JSON.stringify(read());
    pendingGroups={};
  }
  var reloadTimer;
  var pendingReload=false;
  var unfocused=false;
  function reloadNow(){
    if(pendingReload&&(unfocused||document.visibilityState==='hidden'||!document.hasFocus())){pendingReload=false;location.reload()}
  }
  function scheduleReload(){clearTimeout(reloadTimer);reloadTimer=setTimeout(reloadNow,800)}
  function applyRemote(payload){
    if(!isObject(payload)||payload.source===CLIENT_ID)return;
    var p=payload.profile;
    if(!isObject(p))return;
    // Do not mark the reset here: the reloaded page must clear again before
    // the app boots, otherwise an in-flight settings write can restore the
    // old values.
    if(needsReset(p)){applyingRemote=true;clearSynced();applyingRemote=false;location.reload();return}
    applyingRemote=true;
    var changed=applyProfile(p);
    applyingRemote=false;
    snapshots();
    if(changed.theme){
      for(var k in p.values){
        if((k==='opencode-theme-id'||k==='opencode-color-scheme')&&Object.prototype.hasOwnProperty.call(p.values,k)){
          try{window.dispatchEvent(new StorageEvent('storage',{key:k,newValue:localStorage.getItem(k),storageArea:localStorage,url:location.href}))}catch(e){}
        }
      }
    }
    if(changed.settings){pendingReload=true;scheduleReload()}
  }
  try{
    var proto=Object.getPrototypeOf(localStorage);
    var setItem=proto.setItem, removeItem=proto.removeItem, clear=proto.clear;
    proto.setItem=function(key,value){
      setItem.call(this,key,value);
      if(applyingRemote)return;
      if(key===SETTINGS_KEY){
        var a=JSON.stringify(readSection('appearance'));
        var s=JSON.stringify(readPreferenceSections());
        var groups=[];
        if(a!==settingsBefore){settingsBefore=a;groups.push('settings')}
        if(s!==sectionsBefore){sectionsBefore=s;groups.push('preferences')}
        if(groups.length)schedule(false,groups);
      }else if(THEME_KEYS.indexOf(key)>=0){var v=String(value);if(v!==themeBefore[key]){themeBefore[key]=v;schedule(false,['values'])}}
      else if(SYNC_PREFERENCES&&PREF_KEYS.indexOf(key)>=0){var pv=String(value);if(pv!==prefBefore[key]){prefBefore[key]=pv;schedule(false,['preferences'])}}
    };
    proto.removeItem=function(key){
      removeItem.call(this,key);
      if(applyingRemote)return;
      if(key===SETTINGS_KEY){
        var a=JSON.stringify(readSection('appearance'));
        var s=JSON.stringify(readPreferenceSections());
        var groups=[];
        if(a!==settingsBefore){settingsBefore=a;groups.push('settings')}
        if(s!==sectionsBefore){sectionsBefore=s;groups.push('preferences')}
        if(groups.length)schedule(false,groups);
      }else if(THEME_KEYS.indexOf(key)>=0&&themeBefore[key]!==null){themeBefore[key]=null;schedule(false,['values'])}
      else if(SYNC_PREFERENCES&&PREF_KEYS.indexOf(key)>=0&&prefBefore[key]!==null){prefBefore[key]=null;schedule(false,['preferences'])}
    };
    proto.clear=function(){
      clear.call(this);
      if(applyingRemote)return;
      snapshots();
      schedule(false,['all']);
    };
  }catch(e){}
  window.addEventListener('blur',function(){unfocused=true;reloadNow()});
  window.addEventListener('focus',function(){unfocused=false});
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')reloadNow()});
  if(typeof EventSource==='function'){
    try{var events=new EventSource(ENDPOINT+'/events');events.onmessage=function(e){applyRemote(parse(e.data))}}catch(e){}
  }
  function shouldSeed(){
    var values=PROFILE.values||{}, settings=PROFILE.settings||{}, preferences=PROFILE.preferences||{};
    for(var i=0;i<THEME_KEYS.length;i++){if(!Object.prototype.hasOwnProperty.call(values,THEME_KEYS[i])&&localStorage.getItem(THEME_KEYS[i])!==null)return true}
    if(Object.keys(settings).length===0&&Object.keys(readSection('appearance')).length>0)return true;
    if(SYNC_PREFERENCES){
      var prefValues=preferences.values||{};
      for(var j=0;j<PREF_KEYS.length;j++){if(!Object.prototype.hasOwnProperty.call(prefValues,PREF_KEYS[j])&&localStorage.getItem(PREF_KEYS[j])!==null)return true}
      var prefSections=preferences.sections||{};
      for(var m=0;m<PREF_SECTIONS.length;m++){if(Object.keys(prefSections[PREF_SECTIONS[m]]||{}).length===0&&Object.keys(readSection(PREF_SECTIONS[m])).length>0)return true}
    }
    return false;
  }
  if(shouldSeed())schedule(true,['all']);
})();`;
}

/**
 * Insert the appearance script into an OpenCode index page.
 *
 * The page's CSP contains a sha256 hash for the existing theme preload script,
 * so callers must add the returned hash to `script-src` as well.
 */
export function injectAppearanceSync(
  html: string,
  profile: AppearanceProfile,
  options: AppearanceScriptOptions = {},
): { html: string; hash: string } {
  const script = appearanceScript(profile, options);
  const tag = `<script id="oc-appearance-sync">${script}</script>`;
  const marker = '<script id="oc-theme-preload-script">';
  const at = html.indexOf(marker);
  const withScript =
    at >= 0
      ? html.slice(0, at) + tag + html.slice(at)
      : html.includes('</head>')
        ? html.replace('</head>', tag + '</head>')
        : tag + html;
  return { html: withScript, hash: sha256Base64(script) };
}

/** Add a script hash to an existing Content-Security-Policy header. */
export function addCspHash(csp: string | undefined, hash: string): string {
  const token = `'sha256-${hash}'`;
  if (!csp) return `script-src ${token}`;
  if (csp.includes(token)) return csp;
  const directive = /(^|;\s*)script-src(\s+[^;]*)?/i;
  if (directive.test(csp)) {
    return csp.replace(directive, (_match, prefix: string, rest: string | undefined) => `${prefix}script-src${rest ?? ''} ${token}`);
  }
  return `${csp.replace(/;?\s*$/, '')}; script-src ${token}`;
}

/**
 * Returned instead of OpenCode's Workbox service worker. The real SW precaches
 * index.html, which would hide a freshly injected profile until the SW updates.
 * This passive worker has no fetch handler, so navigations go to the proxy;
 * activating it also drops the old Workbox caches.
 */
export const DISABLED_SERVICE_WORKER = [
  "self.addEventListener('install',function(){self.skipWaiting()});",
  "self.addEventListener('activate',function(e){e.waitUntil((async function(){",
  "await self.clients.claim();",
  "try{var keys=await caches.keys();await Promise.all(keys.map(function(k){return caches.delete(k)}))}catch(e){}",
  "})())});",
].join('');
