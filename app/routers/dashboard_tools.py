from flask import Blueprint, request, jsonify
import requests
from app.services import import_video_metadata

dashboard_tools_bp = Blueprint('dashboard_tools', __name__)

@dashboard_tools_bp.route('/import_videos', methods=['POST'])
def import_selected_videos():
    selected_videos = request.json.get('selected_videos', [])
    if not selected_videos:
        return jsonify({'error': 'No videos selected'}), 400

    try:
        imported_metadata = import_video_metadata(selected_videos)
        return jsonify(imported_metadata), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500
