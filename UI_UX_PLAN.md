# Starbucks-Inspired Minimal UI/UX Redesign Plan

## Objectives
- Deliver a calm, premium interface with Starbucks-inspired earth tones, warm neutrals, and subtle green accents.
- Maintain developer-friendly clarity with cleaner hierarchy, consistent spacing, and reduced visual noise.
- Preserve existing workflows (upload -> verify table -> enter total -> calculate -> review summary) while streamlining navigation and readability.
- Provide cohesive light/dark modes, micro-interactions, and component standards for future iteration.

## Layout & Information Architecture
- **Global shell**: Keep a centered, max-width content column with generous gutters. Introduce a top bar with compact brand lockup, environment indicator (e.g., “OCR ready”), and quick links (Docs/Feedback).
- **Primary flow**: Stack sections in clear stages: Upload → Table Review → Tip Input → Distribution Summary. Use numbered section headings with muted dividers for scannability.
- **Responsive grid**: Two-column layout on desktop (`min 320px cards`), single column on mobile. Preserve table overflow scrolling but add sticky section headers to keep context.
- **Sticky action rail**: On wide screens, pin the "Calculate Distribution" action in a right column or floating footer with soft shadow; on mobile, use a bottom sheet-style call-to-action.
- **Whitespace rhythm**: Base spacing scale of 4/8/12/16/24/32px; cards breathe with 24–28px padding desktop, 16–20px mobile.

## Visual System
- **Color palette** (light):
  - Canvas: #f7f3ed; Cards: #ffffff; Muted text: #6b746e
  - Primary accent: #2f6f3d (Starbucks green); Secondary accent: #b28a5a (warm caramel); Support: #d9c9b1 (oat beige); Lines: #e3ddd3
- **Color palette** (dark):
  - Canvas: #0f1b17; Cards: #14241e; Muted text: #9fb3a7
  - Primary accent: #3fa15f; Secondary accent: #caa472; Support: #2a3a32; Lines: #1f332b
- **Typography**: Keep Inter for versatility; use 600 weight for headings, 500 for labels, 400 for body. Increase base font to 16px; headings 18–22px with relaxed line-height.
- **Shadows & depth**: Soft, low-contrast shadows (e.g., `0 14px 40px rgba(15, 27, 23, 0.18)` on light; `0 12px 32px rgba(0,0,0,0.28)` on dark). Rounded corners 14–18px; pill buttons 999px.
- **Iconography**: Swap emoji for simple line icons (upload, table, calculator, receipt) to reduce noise; keep minimal stroke weight.

## Component Recommendations
- **Header** (`.header`, `.logo` in `index.html`/`styles.css`):
  - Replace emoji with SVG mark; add subtle background blur and bottom border using palette lines.
  - Include theme toggle, status dot for OCR availability, and optional profile/help icons.
- **Upload card** (`.upload-card`):
  - Offer dual actions: “Choose Photo” and “Take Photo”; add drop-zone styling with dashed border, hover glow, and concise helper text.
  - Integrate a progress/loading micro-animation in the drop zone when OCR runs; show file name and size with a tiny badge for status.
- **Partners table** (`#partners-section`):
  - Convert table header into a sticky bar with section title, row count, and clear/add buttons grouped as ghost buttons.
  - Use zebra striping with very subtle tints; emphasize editable cells with focus rings and inline validation for numbers.
  - Add empty-state illustration and CTA when no rows exist.
- **Tip input & action** (`#total-tips`, action card):
  - Place input and calculate action side-by-side on desktop with a descriptive helper block that explains rounding (nearest dollar, hourly rate precision).
  - Add inline numeric keypad styling on mobile and a secondary link to view calculation rules.
- **Results summary** (`#results-section`, `.summary-grid`, `.partner-grid`):
  - Introduce stacked stat cards with icon chips and concise labels; ensure consistent currency formatting.
  - Partner payouts use a vertical card stack with name, partner number, hours, payout pill, and bill breakdown chips.
  - Provide quick filters/sort (by hours, payout) and copy/download actions.
- **Footer**: Convert to muted text with inline links (About, Privacy) and store info tag; keep low contrast to avoid distraction.

## Interaction & Micro-interactions
- **States**: Define rest/hover/active/disabled for buttons and inputs; use subtle scale (1–2%) and shadow shifts on hover, opacity for disabled.
- **Feedback**: Show inline toasts at top-right for parse success/error; use progress bar for OCR operations instead of text logs.
- **Motion**: Prefer 180–220ms easing (`cubic-bezier(0.25, 0.1, 0.25, 1)`) for fades/slides; animate card entrance on section completion.
- **Accessibility**: 4.5:1 contrast for text; focus rings in accent green; support keyboard nav for table rows and action buttons.

## Light/Dark Mode Guidance
- Provide a toggle in the header that switches CSS variables for background, cards, borders, and text.
- Maintain consistent accent hues between modes; adjust shadow opacity and border contrasts per palette above.
- Persist preference in `localStorage` and honor `prefers-color-scheme` for defaults.

## Component Library Tokens
- **Spacing**: `--space-1: 4px`, `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-5: 24px`, `--space-6: 32px`.
- **Radii**: `--radius-s: 10px`, `--radius-m: 14px`, `--radius-l: 18px`, `--radius-pill: 999px`.
- **Shadows**: `--shadow-soft: 0 10px 28px rgba(15, 27, 23, 0.16)` (light), `--shadow-soft-dark: 0 12px 30px rgba(0, 0, 0, 0.28)` (dark).
- **Typography**: `--font-family: 'Inter', system-ui, sans-serif`; `--font-size-base: 16px`; `--font-size-lg: 18px`; `--font-size-xl: 20px`.
- **Borders**: `--border: 1px solid var(--line)`; `--line: #e3ddd3` (light), `--line-dark: #1f332b` (dark).

## Page-level Layout Proposal
1. **Top bar**: Logo + app name, theme toggle, OCR status dot, quick links.
2. **Stage 1: Upload**
   - Split card with drop zone on left, tips on right (supported formats, privacy note, mobile choose/take options).
   - Inline preview with replace/remove controls.
3. **Stage 2: Partner table**
   - Sticky header row with add/clear; table inside scroll container with soft border and zebra rows.
   - Inline add-row button at bottom; total hours row anchored with accent badge.
4. **Stage 3: Tip entry + action**
   - Card grouping total tips input, rounding helper, and calculate button; keep button sticky on mobile bottom.
5. **Stage 4: Results**
   - Summary stats grid, then partner cards grid with bills breakdown; action row for copy/download/print.
6. **Footer**: Low-emphasis links and store tag.

## Implementation Steps
- Refactor CSS to use CSS variables for light/dark palettes and spacing tokens; remove emoji icons in favor of SVG set.
- Update `index.html` structure to follow staged layout and add header/footer enhancements.
- Introduce utility classes for grid, flex alignment, pills, chips, and icon buttons to ensure consistency.
- Add JS hooks for theme toggling, sticky calculate action, toast notifications, and OCR status dot binding.
- Apply micro-interactions (hover/active/focus) uniformly across upload, table actions, and result cards.

## Acceptance Criteria
- Light and dark themes available with Starbucks-inspired palette; toggling persists across sessions.
- Upload flow offers both "Choose" and "Take" options on mobile; drop zone shows loading animation during OCR.
- Cards, buttons, and inputs share consistent radii, shadows, and spacing; typography scale improved for readability.
- Results area presents clear stat hierarchy and partner payout cards with bills breakdown; supports sort/filter.
- Reduced visual noise: no emoji, limited color usage, ample whitespace, and restrained shadows.
