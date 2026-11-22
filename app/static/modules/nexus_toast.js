/**
 * NexusToast — jednotný globálny notifikačný systém pre celý Nexus_v3.
 * Používa token --z-toast (160) a jednotný kontajner #nexus-toast-host.
 * Pri otvorenom natívnom <dialog> využíva Popover top-layer, aby toasty nikdy
 * neostali skryté za dialógom (napr. MEGA Hub).
 */
(function (global) {
    'use strict';

    const KNOWN_TYPES = new Set(['info', 'success', 'warning', 'error']);
    const DEFAULT_ICONS = {
        info: 'info',
        success: 'check_circle',
        warning: 'warning',
        error: 'error',
    };
    const MAX_VISIBLE = 5;

    let seq = 0;
    const activeItems = new Map();

    function translate(message, isHtml) {
        if (isHtml || typeof message !== 'string') return message;
        try {
            if (global.nexusI18n && typeof global.nexusI18n.t === 'function') {
                return global.nexusI18n.t(message);
            }
        } catch (_) { /* i18n je voliteľné */ }
        return message;
    }

    function ensureHost() {
        if (typeof document === 'undefined' || !document.body) return null;
        let host = document.getElementById('nexus-toast-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'nexus-toast-host';
            host.className = 'toast-container nx-toast-host';
            host.setAttribute('role', 'region');
            host.setAttribute('aria-live', 'polite');
            host.setAttribute('aria-label', 'Oznámenia');
            document.body.appendChild(host);
        }
        // Ak prehliadač podporuje Popover API a v DOMe je otvorený <dialog>,
        // povýšime host do top-layeru, aby boli toasty viditeľné nad modálnym dialógom.
        const hasOpenDialog = Boolean(document.querySelector('dialog[open]'));
        if (hasOpenDialog && typeof host.showPopover === 'function') {
            try {
                if (!host.hasAttribute('popover')) {
                    host.setAttribute('popover', 'manual');
                }
                if (!host.matches(':popover-open')) {
                    host.showPopover();
                }
            } catch (_) { /* ignorovať v prostrediach bez plnej podpory popover */ }
        } else if (!hasOpenDialog && host.hasAttribute('popover')) {
            try {
                if (host.matches(':popover-open') && typeof host.hidePopover === 'function') {
                    host.hidePopover();
                }
                host.removeAttribute('popover');
            } catch (_) { /* ignorovať */ }
        }
        return host;
    }

    function normalizeArgs(message, iconOrOptions, type, duration, isHtml) {
        if (iconOrOptions && typeof iconOrOptions === 'object') {
            const opts = iconOrOptions;
            const resolvedType = KNOWN_TYPES.has(opts.type) ? opts.type : 'info';
            return {
                message,
                icon: opts.icon || DEFAULT_ICONS[resolvedType],
                type: resolvedType,
                duration: typeof opts.duration === 'number' ? opts.duration : 3200,
                isHtml: Boolean(opts.isHtml),
            };
        }

        let resolvedIcon = iconOrOptions;
        let resolvedType = type;
        let resolvedDuration = duration;
        let resolvedIsHtml = isHtml;

        // Podpora 2-argumentovej skratky: showToast('Uložené', 'success')
        if (KNOWN_TYPES.has(resolvedIcon) && resolvedType === undefined) {
            resolvedType = resolvedIcon;
            resolvedIcon = DEFAULT_ICONS[resolvedType];
        } else if (KNOWN_TYPES.has(resolvedIcon) && typeof resolvedType === 'number') {
            // showToast('Uložené', 'success', 4000)
            resolvedDuration = resolvedType;
            resolvedType = resolvedIcon;
            resolvedIcon = DEFAULT_ICONS[resolvedType];
        }

        resolvedType = KNOWN_TYPES.has(resolvedType) ? resolvedType : 'info';
        resolvedIcon = resolvedIcon || DEFAULT_ICONS[resolvedType];
        resolvedDuration = typeof resolvedDuration === 'number' && resolvedDuration >= 0 ? resolvedDuration : 3200;

        return {
            message,
            icon: resolvedIcon,
            type: resolvedType,
            duration: resolvedDuration,
            isHtml: Boolean(resolvedIsHtml),
        };
    }

    function dismiss(id) {
        const entry = activeItems.get(id);
        if (!entry) return;
        activeItems.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.el) {
            entry.el.classList.remove('is-visible');
            entry.el.classList.add('is-leaving');
            setTimeout(() => {
                entry.el?.remove();
                if (activeItems.size === 0) {
                    const host = document.getElementById('nexus-toast-host');
                    if (host && host.hasAttribute('popover')) {
                        try {
                            if (host.matches(':popover-open') && typeof host.hidePopover === 'function') {
                                host.hidePopover();
                            }
                            host.removeAttribute('popover');
                        } catch (_) {}
                    }
                }
            }, 220);
        }
    }

    function clear() {
        for (const id of [...activeItems.keys()]) {
            dismiss(id);
        }
    }

    function show(message, iconOrOptions, type, duration, isHtml) {
        const opts = normalizeArgs(message, iconOrOptions, type, duration, isHtml);
        const text = translate(opts.message, opts.isHtml);
        const id = `nx-toast-${Date.now().toString(36)}-${++seq}`;
        const host = ensureHost();
        if (!host) {
            return id;
        }

        // Obmedzenie počtu naraz zobrazených toastov
        while (activeItems.size >= MAX_VISIBLE) {
            const oldestId = activeItems.keys().next().value;
            if (!oldestId) break;
            dismiss(oldestId);
        }

        const el = document.createElement('div');
        el.className = `toast nx-toast ${opts.type}`;
        el.dataset.toastId = id;
        el.setAttribute('role', opts.type === 'error' ? 'alert' : 'status');

        const iconEl = document.createElement('span');
        iconEl.className = 'material-icons-round nx-toast-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = opts.icon;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'nx-toast-body';
        if (opts.isHtml) {
            bodyEl.innerHTML = String(text ?? '');
        } else {
            bodyEl.textContent = String(text ?? '');
        }

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'nx-toast-close';
        closeBtn.setAttribute('aria-label', 'Zavrieť oznámenie');
        closeBtn.innerHTML = '<span class="material-icons-round" aria-hidden="true">close</span>';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss(id);
        });

        el.append(iconEl, bodyEl, closeBtn);
        host.appendChild(el);

        const entry = { id, el, timer: null, duration: opts.duration };
        activeItems.set(id, entry);

        const scheduleDismiss = (ms) => {
            if (entry.timer) clearTimeout(entry.timer);
            if (ms > 0) {
                entry.timer = setTimeout(() => dismiss(id), ms);
            }
        };

        el.addEventListener('mouseenter', () => {
            if (entry.timer) {
                clearTimeout(entry.timer);
                entry.timer = null;
            }
        });
        el.addEventListener('mouseleave', () => {
            if (activeItems.has(id) && entry.duration > 0) {
                scheduleDismiss(Math.min(entry.duration, 1800));
            }
        });

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => el.classList.add('is-visible'));
        } else {
            el.classList.add('is-visible');
        }
        scheduleDismiss(opts.duration);
        return id;
    }

    const NexusToast = {
        show,
        success: (message, duration = 3500, icon = 'check_circle') => show(message, icon, 'success', duration),
        error: (message, duration = 5000, icon = 'error') => show(message, icon, 'error', duration),
        warning: (message, duration = 4000, icon = 'warning') => show(message, icon, 'warning', duration),
        info: (message, duration = 3200, icon = 'info') => show(message, icon, 'info', duration),
        dismiss,
        clear,
        get activeCount() {
            return activeItems.size;
        },
    };

    global.NexusToast = NexusToast;
    global.showToast = (message, icon, type, duration, isHtml) =>
        NexusToast.show(message, icon, type, duration, isHtml);
})(typeof window !== 'undefined' ? window : globalThis);
