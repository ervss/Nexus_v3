/* ============================================================
   NEXUS BUS — frontend client for the NexusEvent WebSocket (A1)
   ------------------------------------------------------------
   Connects to /ws/status, subscribes to topics, replays server
   history, auto-reconnects with backoff. Zero dependencies.

   Usage:
       NexusBus.on('ratelimit.*', ev => console.log(ev));
       NexusBus.on('job.state',   ev => ...);
       // ev = {topic, entity, state, message, metrics, ts}
   ============================================================ */
(function () {
    'use strict';

    const listeners = [];          // {pattern, regex, cb}
    const patterns = new Set();    // server-side subscription patterns
    let ws = null;
    let retryMs = 1000;
    let openTimer = null;

    function patternToRegex(pattern) {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp('^' + escaped + '$');
    }

    function dispatch(ev) {
        for (const l of listeners) {
            if (l.regex.test(ev.topic)) {
                try { l.cb(ev); } catch (e) { console.error('[NexusBus] listener error', e); }
            }
        }
    }

    function sendSubscriptions() {
        if (ws && ws.readyState === WebSocket.OPEN && patterns.size) {
            ws.send(JSON.stringify({ subscribe: Array.from(patterns) }));
        }
    }

    function connect() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${location.host}/ws/status`);

        ws.onopen = () => {
            retryMs = 1000;
            sendSubscriptions();
        };

        ws.onmessage = (msg) => {
            let data;
            try { data = JSON.parse(msg.data); } catch { return; }
            if (data.type === 'event') {
                dispatch(data);
            } else if (data.type === 'event-history' && Array.isArray(data.events)) {
                data.events.forEach(dispatch);
            } else if (data.type === 'log') {
                dispatch({ topic: 'log', entity: '', state: data.level || 'info',
                           message: data.message || '', metrics: {}, ts: data.timestamp });
            }
            // 'pulse' frames are heartbeats — nothing to do
        };

        ws.onclose = () => {
            clearTimeout(openTimer);
            openTimer = setTimeout(connect, retryMs);
            retryMs = Math.min(retryMs * 2, 30000);
        };

        ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    }

    window.NexusBus = {
        /** Subscribe to a topic pattern, e.g. 'ratelimit.*' or '*'. */
        on(pattern, cb) {
            listeners.push({ pattern, regex: patternToRegex(pattern), cb });
            if (!patterns.has(pattern)) {
                patterns.add(pattern);
                sendSubscriptions();
            }
            return cb;
        },
        off(cb) {
            const i = listeners.findIndex(l => l.cb === cb);
            if (i >= 0) listeners.splice(i, 1);
        },
        get connected() {
            return !!(ws && ws.readyState === WebSocket.OPEN);
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', connect);
    } else {
        connect();
    }
})();
