/**
 * RapidAPI YouTube Downloader Integration Test
 *
 * Configuration:
 * - Host: yt-video-audio-downloader-api.p.rapidapi.com
 * - Key: 90e2561aefmshb1e09ecc9fe7ff0p1c02c6jsnc7805861cede
 */

const RAPIDAPI_KEY = '90e2561aefmshb1e09ecc9fe7ff0p1c02c6jsnc7805861cede';
const RAPIDAPI_HOST = 'yt-video-audio-downloader-api.p.rapidapi.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function testRapidAPI() {
  const testUrl = 'https://www.youtube.com/watch?v=Zb23f_1wPYg';

  try {
    console.log('--- 1. Testing video_info ---');
    const infoResponse = await fetch(`https://${RAPIDAPI_HOST}/video_info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': RAPIDAPI_HOST,
        'x-rapidapi-key': RAPIDAPI_KEY,
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify({ url: testUrl })
    });
    const info = await infoResponse.json();
    console.log(`Title: ${info.title}`);
    console.log(`Available formats: ${info.formats.map(f => f.type).join(', ')}`);

    console.log('\n--- 2. Testing download as MP4 (720p) ---');
    const mp4Job = await initiateDownload(testUrl, 'mp4', 720);
    console.log(`Job ID: ${mp4Job.jobId}`);

    console.log('\n--- 3. Testing download as MP3 ---');
    const mp3Job = await initiateDownload(testUrl, 'mp3', 128);
    console.log(`Job ID: ${mp3Job.jobId}`);

  } catch (err) {
    console.error('Test failed:', err.message);
  }
}

async function initiateDownload(url, format, quality) {
  const response = await fetch(`https://${RAPIDAPI_HOST}/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': RAPIDAPI_HOST,
      'x-rapidapi-key': RAPIDAPI_KEY,
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify({ url, format, quality })
  });
  if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
  return await response.json();
}

testRapidAPI();
