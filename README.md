# Portfolio Maintenance Notes

## Adding New Videos

The site has had intermittent video cropping on the live pages because the old media grid animation measured the page before video metadata was ready. Videos briefly report a fallback size before the browser knows their real aspect ratio. If Masonry/AnimOnScroll captures that temporary size, it can set the parent media list to a height that is too small. Because the grid CSS clips overflow, the video then looks cut off, and refreshing can appear to fix it because the browser cache changes the load timing.

When adding new videos, use this checklist:

- Keep project media in normal document flow. Do not restore Masonry or AnimOnScroll behavior that absolutely positions `#grid` items or writes a fixed height onto the media list.
- Give every `<video>` its real `width` and `height` attributes so the browser can reserve the correct aspect ratio before metadata loads.
- Use `width: 100%` and `height: auto` for regular videos.
- For YouTube or iframe videos, use a responsive wrapper with a fixed `aspect-ratio`, usually `16 / 9`.
- Keep `preload="metadata"` on videos so the browser gets dimensions early without downloading the whole file.
- Avoid hiding media with `opacity: 0` until JavaScript runs. If a loader or animation fails, the media should still remain visible.
- After adding a video, test the live or production-equivalent page on a slow network, then refresh once and navigate away/back. The media column height should stay taller than the combined media items, and the footer should never overlap the video.

