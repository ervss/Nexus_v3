(() => {
    const panel = document.getElementById("nexus-download-manager");
    if (!panel) return;

    const list = document.getElementById("nx-download-list");
    const count = document.getElementById("nx-download-count");
    const speed = document.getElementById("nx-download-speed");
    const files = document.getElementById("nx-download-files");
    const overall = document.getElementById("nx-download-overall-progress");
    const notice = document.getElementById("nx-download-notice");
    const launcher = document.getElementById("nx-download-launcher");
    const settingsDialog = document.getElementById("nx-download-settings-dialog");
    const settingsForm = document.getElementById("nx-download-settings-form");
    const settings = {
        max_concurrent_downloads: 5,
        connections_per_file: 16,
        download_path: "",
        auto_clear_completed: false,
    };
    const knownStatus = new Map();
    let initialLoad = true;
    let noticeTimer = 0;
    let polling = false;

    function formatBytes(value) {
        const bytes = Math.max(0, Number(value) || 0);
        if (bytes < 1024) return `${bytes} B`;
        const units = ["KB", "MB", "GB", "TB"];
        let size = bytes / 1024;
        let unit = units[0];
        for (let index = 1; size >= 1024 && index < units.length; index += 1) {
            size /= 1024;
            unit = units[index];
        }
        return `${size.toFixed(size < 10 ? 1 : 0)} ${unit}`;
    }

    function formatEta(seconds) {
        if (seconds == null || !Number.isFinite(Number(seconds))) return "ETA —";
        const value = Math.max(0, Math.ceil(Number(seconds)));
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        const remainder = value % 60;
        if (hours) return `ETA ${hours}h ${minutes}m`;
        if (minutes) return `ETA ${minutes}m ${remainder}s`;
        return `ETA ${remainder}s`;
    }

    function formatSpeed(bytes) {
        return `${((Number(bytes) || 0) / 1048576).toFixed(2)} MB/s`;
    }

    function announce(message, kind = "success") {
        window.clearTimeout(noticeTimer);
        notice.textContent = message;
        notice.dataset.kind = kind;
        notice.hidden = false;
        noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 6000);
    }

    async function request(path, options = {}) {
        const response = await fetch(`/api/downloads${path}`, {
            ...options,
            headers: {
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(options.headers || {}),
            },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data);
            throw new Error(detail || `Request failed (${response.status})`);
        }
        return data;
    }

    function setPanelVisible(visible) {
        panel.hidden = !visible;
        launcher.hidden = visible;
        try {
            localStorage.setItem("nexus-downloads-panel-hidden", visible ? "0" : "1");
        } catch (error) {
            console.warn("Could not save download panel visibility", error);
        }
    }

    function button(label, action, gid) {
        const element = document.createElement("button");
        element.type = "button";
        element.textContent = label;
        element.dataset.downloadAction = action;
        element.dataset.gid = gid;
        return element;
    }

    function makeTask(task) {
        const item = document.createElement("li");
        item.className = "nx-download-item";
        const head = document.createElement("div");
        head.className = "nx-download-item-head";
        const name = document.createElement("span");
        name.className = "nx-download-item-name";
        name.textContent = task.filename || task.url || "Download";
        const status = document.createElement("span");
        status.className = "nx-download-item-status";
        status.textContent = task.status;
        head.append(name, status);
        item.append(head);

        const progress = document.createElement("progress");
        progress.max = 100;
        progress.value = Number(task.progress) || 0;
        progress.setAttribute("aria-label", `${name.textContent} progress`);
        item.append(progress);

        const meta = document.createElement("div");
        meta.className = "nx-download-item-meta";
        const completed = document.createElement("span");
        completed.textContent = `${formatBytes(task.completedLength)} / ${formatBytes(task.totalLength)}`;
        const throughput = document.createElement("span");
        throughput.textContent = formatSpeed(task.downloadSpeed);
        const eta = document.createElement("span");
        eta.textContent = formatEta(task.eta);
        const connections = document.createElement("span");
        connections.textContent = `${task.connections || 0} connections`;
        meta.append(completed, throughput, eta, connections);
        item.append(meta);

        if (task.errorMessage) {
            const error = document.createElement("p");
            error.className = "nx-download-error";
            error.textContent = task.errorMessage;
            item.append(error);
        }

        const actions = document.createElement("div");
        actions.className = "nx-download-item-actions";
        if (task.status === "active" || task.status === "waiting") {
            actions.append(button("Pause", "pause", task.gid));
        } else if (task.status === "paused") {
            actions.append(button("Resume", "resume", task.gid));
        }
        if (task.status === "error") actions.append(button("Retry", "retry", task.gid));
        if (task.status !== "complete" && task.status !== "error") {
            actions.append(button("Cancel", "cancel", task.gid));
        }
        if (task.status === "complete" || task.status === "error") {
            actions.append(button("Remove", "remove", task.gid));
        }
        item.append(actions);
        return item;
    }

    function render(data) {
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        const summary = data.summary || {};
        const active = Number(summary.active) || 0;
        const remaining = Number(summary.remaining) || 0;
        const completed = Number(summary.completed) || 0;
        count.textContent = `${active} active · ${summary.waiting || 0} waiting · ${summary.paused || 0} paused`;
        speed.textContent = `${formatSpeed(summary.downloadSpeed)} total`;
        files.textContent = `${remaining} remaining · ${completed} completed`;
        overall.value = Number(summary.progress) || 0;
        document.getElementById("nx-download-badge").textContent = String(remaining);

        const ordered = [...tasks].sort((a, b) => {
            const order = { active: 0, waiting: 1, paused: 2, error: 3, complete: 4 };
            return (order[a.status] ?? 5) - (order[b.status] ?? 5);
        });
        list.replaceChildren();
        if (!ordered.length) {
            const empty = document.createElement("li");
            empty.className = "nx-download-empty";
            empty.textContent = "No downloads yet. Add URLs above or use Download in the gallery.";
            list.append(empty);
        } else {
            for (const task of ordered) list.append(makeTask(task));
        }

        for (const task of tasks) {
            const previous = knownStatus.get(task.gid);
            if (task.status === "complete" && !initialLoad && previous !== "complete") {
                announce(`Download finished: ${task.filename || task.url}`);
            }
            knownStatus.set(task.gid, task.status);
        }
        const visibleGids = new Set(tasks.map((task) => task.gid));
        for (const gid of knownStatus.keys()) {
            if (!visibleGids.has(gid)) knownStatus.delete(gid);
        }
        if (initialLoad) initialLoad = false;
    }

    async function refresh() {
        if (polling || document.hidden) return;
        polling = true;
        try {
            render(await request("/status"));
        } catch (error) {
            count.textContent = "aria2 is unavailable";
            announce(error.message, "error");
        } finally {
            polling = false;
        }
    }

    async function loadSettings() {
        const value = await request("/settings");
        Object.assign(settings, value);
        document.getElementById("nx-download-concurrent").value = settings.max_concurrent_downloads;
        document.getElementById("nx-download-connections").value = settings.connections_per_file;
        document.getElementById("nx-download-path").value = settings.download_path;
        document.getElementById("nx-download-auto-clear").checked = settings.auto_clear_completed;
    }

    document.getElementById("nx-download-start-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = document.getElementById("nx-download-urls");
        const urls = input.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        if (!urls.length) return;
        try {
            const result = await request("/start", {
                method: "POST",
                body: JSON.stringify({ urls }),
            });
            input.value = "";
            announce(`${result.added.length} download${result.added.length === 1 ? "" : "s"} queued`);
            if (result.errors?.length) announce(`${result.errors.length} URL(s) could not be queued`, "error");
            await refresh();
        } catch (error) {
            announce(error.message, "error");
        }
    });

    panel.addEventListener("click", async (event) => {
        const actionButton = event.target.closest("[data-download-action]");
        if (actionButton) {
            const { downloadAction, gid } = actionButton.dataset;
            try {
                const result = await request(`/${downloadAction}/${encodeURIComponent(gid)}`, { method: "POST" });
                if (downloadAction === "retry") announce("Retry queued");
                else if (downloadAction === "cancel") announce("Download cancelled");
                else if (downloadAction === "remove") announce("Download removed");
                else announce(`Download ${result.status}`);
                await refresh();
            } catch (error) {
                announce(error.message, "error");
            }
            return;
        }

        const bulk = event.target.closest("[data-bulk-action]");
        if (bulk) {
            const action = bulk.dataset.bulkAction;
            try {
                const state = await request("/status");
                const eligible = state.tasks.filter((task) => (
                    action === "pause" ? ["active", "waiting"].includes(task.status)
                        : action === "resume" ? task.status === "paused"
                            : ["active", "waiting", "paused"].includes(task.status)
                ));
                const outcomes = await Promise.allSettled(eligible.map((task) => request(
                    `/${action}/${encodeURIComponent(task.gid)}`,
                    { method: "POST" },
                )));
                const failed = outcomes.filter((outcome) => outcome.status === "rejected").length;
                announce(`${eligible.length - failed} download(s) ${action}d${failed ? `; ${failed} failed` : ""}`, failed ? "error" : "success");
                await refresh();
            } catch (error) {
                announce(error.message, "error");
            }
        }
    });

    document.getElementById("nx-download-open-folder").addEventListener("click", async () => {
        try {
            const result = await request("/open-folder");
            announce(`Opened ${result.path}`);
        } catch (error) {
            announce(error.message, "error");
        }
    });

    document.getElementById("nx-download-settings").addEventListener("click", async () => {
        try {
            await loadSettings();
            settingsDialog.showModal();
        } catch (error) {
            announce(error.message, "error");
        }
    });
    document.getElementById("nx-download-settings-cancel").addEventListener("click", () => settingsDialog.close());
    settingsForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const formData = new FormData(settingsForm);
        const updated = {
            max_concurrent_downloads: Number(formData.get("max_concurrent_downloads")),
            connections_per_file: Number(formData.get("connections_per_file")),
            download_path: String(formData.get("download_path") || "").trim(),
            auto_clear_completed: document.getElementById("nx-download-auto-clear").checked,
        };
        try {
            Object.assign(settings, await request("/settings", {
                method: "POST",
                body: JSON.stringify(updated),
            }));
            settingsDialog.close();
            announce("Download settings saved");
            await refresh();
        } catch (error) {
            announce(error.message, "error");
        }
    });

    document.getElementById("nx-download-minimize").addEventListener("click", () => setPanelVisible(false));
    launcher.addEventListener("click", () => setPanelVisible(true));
    try {
        setPanelVisible(localStorage.getItem("nexus-downloads-panel-hidden") !== "1");
    } catch (error) {
        console.warn("Could not restore download panel visibility", error);
    }

    void loadSettings().catch((error) => announce(error.message, "error"));
    void refresh();
    window.setInterval(() => {
        if (!document.hidden) void refresh();
    }, 1000);
})();
