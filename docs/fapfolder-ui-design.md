# FapFolder media library design

## Approved reference and precedence

The user approved `artifacts/fapfolder-redesign/approval.html` and `approval-*.jpg`. This specification now follows that concrete mockup; it supersedes the earlier floating-overlay and footer-only community proposal. Match the approved composition, not merely its colours. Neutral illustration artwork and example counts in the mockup are placeholders: use real available artwork and measured values in production. Never copy illustrative totals into runtime UI.

Actual Chrome baseline captured at artifacts/fapfolder-redesign/before-communities.png on 2026-10-23. Communities currently have large profile header, small circular artwork, a purple selection slab and multiple unrelated floating extension controls. NVS ready badge and separate bubbles compete for ownership. Nexus Gallery should own FapFolder selection and library UI; NVS should stand down on this host.

## Visual system

Use system sans-serif, background #101114, surface #191b20, header/sidebar #16181d, controls #23262e, border #30343e, text #f3f4f6 and muted #a8adb8. Accent #ef8bb3 is reserved for primary action, checked controls and focus; selected outlines #d580a3. Avoid gradients, emoji-heavy action labels and decorative glowing controls. Spacing scale 4/8/12/16/24/32px; radius 14px communities, 12px videos, 8px controls. Body 14px/1.5, labels 12px, page heading 28px with -0.8px tracking, card names17px semibold; tabular numerals for statistics.

## Workspace

One full-width workspace replaces the fixed narrow toolbox and offset gallery. Shared header has NEXUS / FapFolder branding and Komunity / Video knižnica navigation; active tab is a quiet pink-tinted surface. Communities content max-width1440px, padding30px 32px. Heading 'Tvoje komunity' and concise explanation sit left; batch audit and sort sit right. Bottom selection bar shows selected community count and aggregates, with clear-selection and primary 'Otvoriť spoločnú knižnicu'.

Library body has 248px source pane and flexible gallery, with no 400px toolbox gutter. Sidebar padding24px 20px, selected sources as rows with checks, count and completeness; 'Pridať odkaz', primary 'Načítať všetky videá', progress line and per-source error/retry. Main padding24px 28px: 'Spoločná knižnica', inline count/size/average statistics and Close action. Below is a horizontal search/sort/Filters/HD previews toolbar; advanced filters may expand below. Put selected-video total, selected bytes, clear-selection and primary import in a distinct bottom action strip. Preserve all existing advanced features in secondary controls/disclosures. Actions wrap rather than overflow. Do not show the mockup-only design-review badge or explanatory implementation notes in production.

## Community cards

Recompose communities into large rectangular media cards, four columns at desktop with18px gaps. This is a structural redesign, not a footer attached to the old circular-avatar cards. Cover height164px, object-fit cover; overlay25px checkbox at top-left12px. Body padding18px: community name17px, muted12px follower/type line, three equal stats columns between subtle horizontal rules. Stats use17px values and11px labels for videos, total size, average duration. Footer selection state plus secondary 'Zistiť údaje' action. Preserve access to original community links and follow actions without making those the primary Nexus workflow. Selected card has a2px accent border and check; reserve border width to prevent movement. Unknown values use an em dash; partial coverage is explicit, e.g. '16,5 GB · údaje 28/34'. Never imply partial fetch is complete.

## Video cards

Approved desktop grid has three columns and17px gaps, two on tablet, one on narrow screens. Large16:9 preview with object-fit cover, rounded top corners; duration bottom-right10px and checkbox top-left10px on opaque backgrounds, accessible central play action. Body padding12px 14px, two-line14px semibold title, muted11px size/quality metadata and compact HD state. Source remains identifiable. Play and item actions stay keyboard/touch accessible. Selected card has checked control plus2px pink inset outline. Hover raises contrast subtly, never shifts layout. Unknown thumbnail has a neutral placeholder, not broken-image chrome.

## States and accessibility

Initial: explain selecting communities or adding source URLs, disable create-grid until sources exist. Loading: page/source count, current operation, inline progress and Stop; preserve already collected cards. Empty after filters: say no matching videos and offer reset. Error: inline source-specific message and Retry, keep successful sources. Complete: state coverage honestly. Stopped: label partial collection and retain results. Import: disabled during submission, visible result/error. Focus-visible 2px accent outline with 3px offset; minimum 36px controls desktop and 44px touch. Use labels, native buttons/checkboxes, aria-live polite progress and reduced-motion support.

## Responsive behaviour

At900px community and video grids become two columns and sidebar210px. Below600px use single-column community/video cards,18px page padding and stacked page-heading/selection-bar controls. The mockup hides the sidebar at this width; production must retain source functionality through a clearly labelled expandable Sources control rather than make it unreachable. Wrap summary and toolbar, preserve visible Close and prevent horizontal scroll. Keep source selection and video selection semantically distinct. For hundreds of items use lazy images and stable card sizes; fetch progress must remain legible while scrolling.

## Acceptance evidence

Verify actual browser selection, source fetch, combined grid, filtering, playback, HD preview, import and stop/error handling. Screenshot before/after communities and library plus narrow viewport. Report live extension/version blockers explicitly. A local fixture supports layout evidence but is not live-site verification.
