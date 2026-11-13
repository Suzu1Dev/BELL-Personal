# BELL Personal — C「銳 Precise」UX addendum

Date: 2026-11-08. Direction: `design/v2/DECISION.md` (`78cebff`). Design base: `1514d02`. Implementation SHA: `0cec68d6d4b82e58d869d1f3953d4421efed8137`.

This addendum supersedes only the rules named below. Product behaviour, routes, data, handoff validation, explicit-write confirmation and failure semantics not named here remain unchanged.

## Replaced rules

- `SPEC-ux.md` line 3's locked v1 presentation and line 14's “Don't restyle it” are superseded for the C presentation layer. The v1 component behaviour and state requirements still apply.
- `engineering-brief.md` §A1's “hand-written CSS (no Tailwind, no component library)” is superseded by Tailwind CSS 4 at build time, Radix primitives, cmdk, Motion and local components. TypeScript remains the application logic language.
- `SPEC-ux.md` §2 and `FRONTEND.md` §8 colour/type tokens are superseded by `src/styles/precise-tokens.css` and the semantic aliases in `src/styles/precise.css`. Geist and Geist Mono are local Latin fonts; Traditional Chinese uses PingFang TC, Noto Sans CJK TC or Microsoft JhengHei from the system. Inter is not the C Latin face.
- `SPEC-ux.md` §3's sentence-style page heads, eyebrows and explanatory sublines are replaced by concise place names. Pure helper text is omitted, not hidden. Daily brief content and its loading/error state, EndMark, unread counts, project descriptions and actionable source errors remain.
- `SPEC-ux.md` §6.2's ⌘K/Ctrl+K command-palette binding is replaced for the suite switcher. ⌘K/Ctrl+K opens product switch; Ctrl+1–3 selects Personal, Explain or PR. The topbar 搜尋 button still opens the existing command palette directly; N and capture behaviour are unchanged.
- The switcher uses cmdk filtering and arrow selection, Radix Popover on desktop and a native modal `<dialog>` with Motion on phones. Focus, Escape, reduced motion and unconfigured/current disabled states are required.
- All native dialogs and their focus/inert behaviour remain. Their visual tokens follow C; they are not converted to Radix Dialog in this direction.
- The minimum supported viewport remains 320px; no stylesheet may raise it to 360px. Touch targets remain at least 44px on coarse pointers.
- Today habit chips keep the existing 2–4 character `short` contract and user aliases. At ≤400px the single-column chip displays the existing full `habit.name` with wrapping and no truncation; 401–1080px keeps the compact `short`, and the wide habit rows are unchanged. The whole ≥44px chip remains the hit area throughout pointer down/up; press motion scales only the icon, never the button that establishes the hit area's containing block.
- When the Today filter chips actually overflow horizontally, a focused option scrolls with both `block: "nearest"` and `inline: "nearest"`. The row removes its fade mask while `:focus-within`; non-overflowing chip rows do not programmatically scroll. Options, ordering and keyboard semantics are unchanged.
- Composer tabs follow the ARIA keyboard pattern: Arrow Left/Right (including wraparound), Home and End leave focus on the newly selected tab after the next animation frame. Enter and Space activate a tab without moving focus into the textarea. Mouse and touch tab changes focus the textarea after the next animation frame so typing can continue immediately. Per-tab drafts and all other tab behavior are unchanged.
- After any non-composing keydown on the in-page tablist, the focused tab shows the existing 2px `--personal-text` outline inset by 3px even if a preceding pointer interaction was cancelled or dragged off the tab. A later pointerdown clears this explicit keyboard-focus state; link tabs keep their native focus behavior.

## Scope and dependencies

Every existing route and section remains. No 「待確認」 route, suggestion queue or Today cell is added. UI and documentation use 「靈感」 consistently. No API, storage, handoff or model-call contract changes are part of this addendum.

New build-time/UI dependencies are exactly pinned and were published more than 14 days before adoption:

- `@radix-ui/react-popover 1.3.1`: desktop switcher focus and dismissal.
- `cmdk 1.1.1`: accessible product filtering and keyboard selection.
- `motion 14.6.0`: phone sheet motion with reduced-motion handling.
- `tailwindcss 4.3.2` and `@tailwindcss/vite 4.3.2`: build-time C utilities; no runtime CDN.

Local font files and their OFL texts are in `public/fonts/`. No font, script, style or telemetry CDN is added, and CSP is unchanged.

Final visual acceptance requires real light/dark screenshots at 1440px and 390px, plus the existing 320px functional reflow check. Container resizing is not a viewport substitute.
