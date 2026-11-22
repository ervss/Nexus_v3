// popup.js
document.addEventListener('DOMContentLoaded', function() {
  const popup = document.getElementById('video-import-popup');
  const closeButton = document.querySelector('.close-button');
  const videoList = document.getElementById('video-list');
  const importButton = document.getElementById('import-button');

  // Function to open the popup
  function openPopup() {
    popup.style.display = 'block';
  }

  // Function to close the popup
  function closePopup() {
    popup.style.display = 'none';
  }

  // Event listener for close button
  closeButton.addEventListener('click', closePopup);

  // Event listener for import button
  importButton.addEventListener('click', function() {
    const selectedVideos = Array.from(videoList.querySelectorAll('input[type="checkbox"]:checked'))
      .map(checkbox => checkbox.value);
    console.log('Selected Videos:', selectedVideos);
    closePopup();
  });

  // Function to populate the video list with checkboxes
  function populateVideoList(videos) {
    videos.forEach(video => {
      const li = document.createElement('li');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = video;
      li.appendChild(checkbox);
      li.appendChild(document.createTextNode(video));
      videoList.appendChild(li);
    });
  }

  // Example data (replace with actual data retrieval logic)
  const videos = ['video1.mp4', 'video2.mp4', 'video3.mp4'];
  populateVideo_list(videos);

  // Trigger the popup
  openPopup();
});