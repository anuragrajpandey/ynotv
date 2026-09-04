# Changelog

## v2.5.2

### Added

- **Channel list scrolling optimizations** - Scrolling the channel list is now smoother for users with multiple playlists/categories.
- **Three-column EPG layout** - A new Live TV layout places the channel list on the left with only the airing program, preview in the top right, and the program details panel in the bottom-right. Enable under `Settings → Live TV → Three Column View`.
- **Auto-hide category sidebar in Live TV** - The category sidebar can now be set to open on hover and auto-hide when not in use, freeing up screen space. Enable under `Settings → Live TV`.
- **Adjustable EPG program font size** - The text size of programs in the EPG time grid can be adjusted under `Settings → Live TV → Font Sizes`.
- **Default category on startup** - Choose which category Live TV opens to: keep `Last Opened` (the current behavior) or select a specific category, custom group, favorites, recent, or watchlist from a searchable picker under `Settings → Live TV → Sorts & Channels`.
- **Keyboard as controller** - An HTPC keyboard or wireless remote can now act as a controller, supporting the same spatial navigation, chord shortcuts, and button mappings as a gamepad. Configure under `Settings → Controllers & Remote`.
- **Custom cache size** - A custom timeshift cache size can be set in MB (16–16,384) under `Settings → Cache`, in addition to the existing presets.
- **Virtualized category sidebar** - The Live TV category sidebar now renders only visible rows, ensuring smooth scrolling even when many sources or large playlists are expanded.
- **Large library optimizations** - Reduced lag when opening categories in very large playlists (150k+ channels) through category-membership indexing and scoped database queries.
- **Move to top/bottom in Custom Groups Manager** - Categories in the Custom Groups Manager can now be moved directly to the top or bottom of the group.
- **Stalker VOD page loading indicator** - Lazy-loaded Stalker VOD and series categories now display a "Loading page X of Y" indicator with a progress bar while fetching. Stalker portals return 14 items per page.
- **Extended EPG grid hour range** - The EPG grid can now be set to display 7–10 hours instead of the previous maximum of 6. Requires a sufficiently high screen resolution.
- **EPG sync notification** - A notification toast now appears in the bottom-right corner when a sync is in progress, letting users know that performance may be temporarily reduced until the sync completes.
- **Restrict All channel from loading if >10k channels** - Disabled All category in LiveTV from loading channels if channel count is >10k, as it causes unstability trying to load all the channels. The All category can be hidden in `Settings → Navigation → Category`

### Fixed

- **Channel list not auto-scrolling during channel up/down navigation** - The channel list now correctly follows the selection when navigating with channel up/down controls.
- **Channel up/down scrolling past list edges** - The channel list no longer moves the selection into an off-screen area; it now keeps the selection within the visible bounds at the top and bottom of the list.
- **CC subtitles appearing stacked** - Closed captions on Live TV channels are no longer rendered multiple times on top of each other.
- **Subtitle rendering and reliability fixes** - Resolved several subtitle issues: ASS override inconsistencies between initial playback and settings changes, double-scaling when both font size and scale were applied simultaneously, and subtitle track cycling during stream reconnects and channel changes.
- **libmpv preview going fullscreen unexpectedly** - Clicking a program and returning to the app no longer causes the libmpv stream to expand and take over the full screen. The preview now remains correctly contained within the preview panel.
- **Recently Watched series resuming from the wrong episode** - The Recent tab now resumes from the exact saved episode instead of reverting to an earlier episode when previous episodes were skipped or left unfinished.
- **Custom group duplicate entries** - Adding categories to a custom group no longer creates duplicate entries.
- **Stalker VOD Series "All" category not loading** - The Series All view now loads correctly on portals that serve series under the VOD endpoint, rather than returning empty.
