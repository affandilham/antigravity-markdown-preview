import MarkdownIt from 'markdown-it';

export function embedPlugin(md: MarkdownIt): void {
  const defaultImage =
    md.renderer.rules.image ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') || '';
    const alt = token.content || '';

    // Check for explicit embed alt or url type
    const isEmbed =
      alt.toLowerCase().startsWith('embed') ||
      alt.toLowerCase().startsWith('video') ||
      alt.toLowerCase().startsWith('audio') ||
      alt.toLowerCase().startsWith('youtube');

    // 1. YouTube embed detection
    const ytMatch = src.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    if (ytMatch && (isEmbed || src.includes('youtube') || src.includes('youtu.be'))) {
      const videoId = ytMatch[1];
      return `<div class="antigravity-embed-container embed-youtube">
  <div class="embed-header">
    <span class="embed-type">YouTube Video</span>
    <span class="embed-title">${md.utils.escapeHtml(alt || 'Video')}</span>
  </div>
  <div class="embed-responsive-wrapper">
    <iframe src="https://www.youtube-nocookie.com/embed/${videoId}" 
            title="${md.utils.escapeHtml(alt)}" 
            frameborder="0" 
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" 
            allowfullscreen>
    </iframe>
  </div>
</div>`;
    }

    // 2. Direct Video files (.mp4, .webm, .ogg)
    if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(src)) {
      return `<div class="antigravity-embed-container embed-video">
  <div class="embed-header">
    <span class="embed-type">HTML5 Video</span>
    <span class="embed-title">${md.utils.escapeHtml(alt || 'Video Player')}</span>
  </div>
  <div class="embed-media-wrapper">
    <video controls preload="metadata" style="max-width:100%; border-radius: 8px;">
      <source src="${src}" type="video/mp4">
      Your browser does not support HTML5 video.
    </video>
  </div>
</div>`;
    }

    // 3. Direct Audio files (.mp3, .wav, .aac, .m4a)
    if (/\.(mp3|wav|m4a|aac)(\?.*)?$/i.test(src)) {
      return `<div class="antigravity-embed-container embed-audio">
  <div class="embed-header">
    <span class="embed-type">Audio Player</span>
    <span class="embed-title">${md.utils.escapeHtml(alt || 'Audio Track')}</span>
  </div>
  <div class="embed-media-wrapper">
    <audio controls preload="metadata" style="width:100%;">
      <source src="${src}">
      Your browser does not support HTML5 audio.
    </audio>
  </div>
</div>`;
    }

    // 4. Generic iframe embed if alt is "embed"
    if (isEmbed && (src.startsWith('http://') || src.startsWith('https://'))) {
      return `<div class="antigravity-embed-container embed-iframe">
  <div class="embed-header">
    <span class="embed-type">Embedded View</span>
    <a href="${src}" target="_blank" class="embed-title" rel="noopener noreferrer">${md.utils.escapeHtml(alt || src)}</a>
  </div>
  <div class="embed-responsive-wrapper">
    <iframe src="${src}" 
            title="${md.utils.escapeHtml(alt)}" 
            frameborder="0" 
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            allowfullscreen>
    </iframe>
  </div>
</div>`;
    }

    return defaultImage(tokens, idx, options, env, self);
  };
}
