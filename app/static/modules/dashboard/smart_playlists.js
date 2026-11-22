export function createSmartPlaylistModule() {
    return {
        smartPlaylists: [],
        activeSmartPlaylistId: null,
        showSmartPlaylistModal: false,
        editingPlaylistId: null,
        smartPlaylistForm: { name: '', rules: [] },

        async loadSmartPlaylists() {
            try {
                const res = await fetch('/api/smart-playlists');
                const data = await res.json();
                this.smartPlaylists = Array.isArray(data) ? data : (data.playlists || []);
            } catch (e) {
                console.error('Failed to load smart playlists', e);
            }
        },

        async loadSmartPlaylist(playlistId) {
            this.activeSmartPlaylistId = playlistId;
            this.activeSourceBoardId = null;
            this.oldGalleryMode = false;
            this.filters.favoritesOnly = false;
            this.isLoading = true;
            try {
                const res = await fetch(`/api/smart-playlists/${playlistId}/videos`);
                const data = await res.json();
                this.videos = (Array.isArray(data) ? data : (data.videos || [])).filter(v => v && v.id);
                this.hasMore = false;
            } catch (e) {
                this.showToast('Failed to load playlist videos', 'error', 'error');
            } finally {
                this.isLoading = false;
            }
        },

        openSmartPlaylistModal(playlist = null) {
            if (playlist) {
                this.editingPlaylistId = playlist.id;
                this.smartPlaylistForm.name = playlist.name;
                this.smartPlaylistForm.rules = JSON.parse(JSON.stringify(playlist.rules));
            } else {
                this.editingPlaylistId = null;
                this.smartPlaylistForm.name = '';
                this.smartPlaylistForm.rules = [{ field: 'title', operator: 'contains', value: '' }];
            }
            this.showSmartPlaylistModal = true;
        },

        addSmartPlaylistRule() {
            this.smartPlaylistForm.rules.push({ field: 'title', operator: 'contains', value: '' });
        },

        removeSmartPlaylistRule(index) {
            this.smartPlaylistForm.rules.splice(index, 1);
        },

        async saveSmartPlaylist() {
            const method = this.editingPlaylistId ? 'PUT' : 'POST';
            const url = this.editingPlaylistId ? `/api/smart-playlists/${this.editingPlaylistId}` : '/api/smart-playlists';

            try {
                const res = await fetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.smartPlaylistForm)
                });
                if (res.ok) {
                    this.showToast('Playlist saved', 'check_circle', 'success');
                    this.showSmartPlaylistModal = false;
                    this.loadSmartPlaylists();
                } else {
                    this.showToast('Failed to save playlist', 'error', 'error');
                }
            } catch (e) {
                this.showToast('An error occurred', 'error', 'error');
            }
        }
    };
}

