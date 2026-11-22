/* Local observation only: no URL, cookie, title or browsing history is reported. */
(() => {
    class PlaybackMetrics {
        constructor(clock = () => performance.now(), autoplay = true) {
            this.clock = clock;
            this.started = autoplay ? clock() : null;
            this.lastTime = 0;
            this.startup = null;
            this.stalls = 0;
            this.stallTotal = 0;
            this.stallStart = null;
            this.recoveryStart = null;
            this.recovery = null;
            this.recoveries = 0;
            this.observed = 0;
            this.playStart = null;
        }
        event(name, media) {
            const now = this.clock();
            if (name === 'play' && this.started === null) this.started = now;
            if (name === 'playing' && this.playStart === null) this.playStart = now;
            if (name === 'waiting' && this.startup !== null && !media.paused && !media.seeking && this.stallStart === null) {
                this.stalls++;
                this.stallStart = now;
            }
            if (['playing', 'pause', 'ended', 'stop', 'seeking'].includes(name) && this.stallStart !== null) {
                this.stallTotal += now - this.stallStart;
                this.stallStart = null;
            }
            if (['pause', 'ended', 'stop'].includes(name) && this.playStart !== null) {
                this.observed += now - this.playStart;
                this.playStart = null;
            }
            if (name === 'recover' && this.recoveryStart === null) {
                this.recoveries++;
                this.recoveryStart = now;
            }
            if (name === 'loadstart') this.lastTime = 0;
            if (name === 'timeupdate') {
                if (!media.paused && !media.seeking && media.currentTime > this.lastTime + 0.01) {
                    if (this.startup === null && this.started !== null) this.startup = now - this.started;
                    if (this.recoveryStart !== null) {
                        this.recovery = now - this.recoveryStart;
                        this.recoveryStart = null;
                    }
                }
                this.lastTime = media.currentTime;
            }
        }
        snapshot() {
            const now = this.clock();
            const bounded = value => Math.round(Math.min(86400000, Math.max(0, value)));
            return {
                startup_ms: this.startup === null ? null : bounded(this.startup),
                stalls: Math.min(1000000, this.stalls),
                stall_ms: bounded(this.stallTotal + (this.stallStart === null ? 0 : now - this.stallStart)),
                recovery_ms: this.recovery === null ? null : bounded(this.recovery),
                recoveries: Math.min(1000000, this.recoveries),
                observed_ms: bounded(this.observed + (this.playStart === null ? 0 : now - this.playStart)),
            };
        }
    }
    window.NexusPlaybackMetrics = PlaybackMetrics;
})();
