# Design — A Pachas v2

Identity and UI redesigned with Claude Design from the project file
"A Pachas v2.dc.html"; the previous sand-toned v1 remains historical context.
Editable navigable prototype:
https://claude.ai/design/p/61c29d29-59f4-4f4d-8c5b-df04adba396e

Direction: bright neutral base, festive violet primary, money figures as the
visual lead, green = owed to you, coral = you owe, and ink-dark mode. Avoid
brown or sand-heavy palettes in v2.

## Concept

The logo remains the circular stone oculus/rosette from Santa Maria de la
Sierra monastery in Collado Hermoso, split into five equal portions: paying "a
pachas" means splitting among everyone. It uses `currentColor`; brand color is
violet `#5A50EC`. Beyond the logo, the oculus appears as a giant white 16%
watermark on the violet party card.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <circle cx="24" cy="24" r="19" stroke="#5A50EC" stroke-width="4.5"/>
  <g stroke="#5A50EC" stroke-width="4.5" stroke-linecap="round">
    <line x1="24" y1="24" x2="24" y2="5"/>
    <line x1="24" y1="24" x2="42.1" y2="18.1"/>
    <line x1="24" y1="24" x2="35.2" y2="39.4"/>
    <line x1="24" y1="24" x2="12.8" y2="39.4"/>
    <line x1="24" y1="24" x2="5.9" y2="18.1"/>
  </g>
</svg>
```

## Tokens

| Token           | Light                        | Dark      | Use |
| --------------- | ---------------------------- | --------- | --- |
| `--bg`          | `#F5F6FA`                    | `#101218` | app background |
| `--card`        | `#FFFFFF`                    | `#191C25` | cards, nav, sheet |
| `--ink`         | `#171A21`                    | `#EDEFF6` | primary text |
| `--muted`       | `#6A7186`                    | `#99A0B4` | secondary text, inactive icons |
| `--line`        | `#E6E8F0`                    | `#2A2E3C` | borders, dividers |
| `--primary`     | `#5A50EC`                    | `#9D96FF` | violet: buttons, active tab, action links |
| `--onprimary`   | `#FFFFFF`                    | `#1B1747` | text on primary/green/coral |
| `--primarysoft` | `#ECEAFE`                    | `#2A2750` | active pills/chips, avatars, "Me lo pido" |
| `--green`       | `#0E9256`                    | `#45D48F` | owed to you, bought, done check, WhatsApp |
| `--greensoft`   | `#DCF5E7`                    | `#17362A` | soft green backgrounds |
| `--coral`       | `#E5484D`                    | `#FF8080` | you owe, badge, delete |
| `--coralsoft`   | `#FDE8E8`                    | `#3D2226` | soft coral backgrounds, reserved |
| `--chip`        | `#EFF1F6`                    | `#242836` | neutral chip, "Sin dueño" |
| `--shadow`      | `0 1px 2px rgba(16,18,24,.04)` | `none` | card shadow |

Fixed in both modes: the party card is brand violet `#5A50EC` with white text;
its primary inner button is `--card` with `--primary` text; its secondary button
is translucent white `rgba(255,255,255,.16)`. Sheet veil is
`rgba(13,15,22,.5)`. Live-status dot is `#3DDC84`. Toast uses `--ink` as
background and `--bg` as text. Card radius is 16px. Dark mode is automatic via
`prefers-color-scheme` plus a manual moon toggle at top right with
`position:absolute`, persisted in localStorage.

## Typography

- Display: **Bricolage Grotesque** from Google Fonts. Wordmark 800/34px, 20px
  in the inner header; screen titles 700/26px; card/sheet titles 700/20px; the
  violet party-card title is 21px; "¿Qué toca?" is 700/18px; avatar initial is
  700/16px.
- Money figures always use Bricolage 800 with `tabular-nums`: "Tu cuenta" 32px,
  accounts total 28px, home "Tu saldo" 24px.
- Body: **Instrument Sans**. Buttons 600/15px, names 600/15px, body 400-500/14px,
  meta 400/13px, chips 600/12px, uppercase labels 600/12px with `0.08em`
  tracking, tabs 600/11px. Inputs are intentionally 16px; below that, iOS zooms
  when focusing the field. Do not reduce input font size.
- Fallback: system stack. The app must work without font network access.

## User-Facing Voice

Visible product copy stays in Spanish from Spain. Tone: village Spanish with a
bit of humor, but not overdone.

- "Los gastos de la peña, a partes iguales. Ni pa ti ni pa mí."
- "¿Qué falta? (garrafón no)" · "Me lo pido" · "Ya está comprada"
- "¿Quiénes lo catan?" · "Sin dueño" · "La trae Marta"
- "Ponle precio, que gratis no fue." · "Alguien lo catará, digo yo."
- "Pon qué fue." · "Apuntado. Las cuentas ya lo saben."
- "Todo comprado. Vaya máquinas." · "Cuentas claras y el chocolate espeso."
- Sync copy must avoid technical language: "En vivo con la peña · al día hace
  un momento" with green dot, "Solo en este móvil", "Sin red · conecta para
  cambiar la fiesta", and "Necesitas internet para cambiar la fiesta." Do not
  say sync/version/conflict in user-facing copy, and do not suggest that shared
  changes are saved locally for later upload.
- Admin is "la llave" in the UI, with a discreet key icon. Do not show
  "administrador" to users.

## Screens

1. **Fiesta, actionable home**: header with oculus + wordmark left and moon
   right; violet party card with oculus watermark, translucent white label/meta,
   white "Mandar al grupo" button, translucent "Ponerla en vivo" when local, and
   live-status line with green dot; "¿QUÉ TOCA?" card with Bricolage 18px
   statement and exactly one personalized action (own assigned item first,
   missing group items second, own Bizum third); "TU SALDO" card with large colored number
   and "Mis cuentas"; identity row with avatar and violet "Cambiar"; access
   links for rename/date when key holder, start another party, and demo. Without
   a party: large centered hero plus join/create/demo and up to five recent live
   parties stored on that phone.
2. **Lista**: subtitle "{n} cosas por resolver de {total}"; add row with violet
   button; dashed "+ Apuntar un gasto ya pagado"; cards with state chips ("La
   trae X" primarysoft/primary, "Sin dueño" chip/muted) and actions ("Me lo
   pido" primarysoft, bordered "Asignar", small links); "YA COMPRADAS" section
   with green circular check on the left, "{precio} · pagó {N} · entre {n}",
   editable by tapping; "Mandar lo que falta al grupo" link when unowned items
   exist.
3. **Peña**: avatar rows with violet initials, name, optional key, and balance
   ("le deben" green, "debe" coral, "en paz"); "Mandar al grupo"; manual add.
   Person sheet on tap, with breakdown and shareable reminder. Leaving the group
   makes someone inactive for future expenses; historical purchases, transfers,
   and balances remain visible. Inactive people appear after active people.
4. **Cuentas**: "TU CUENTA" card first: Debes X / Te deben X / Estás en paz in
   Bricolage 800/32px colored text, breakdown "Pagaste · te tocaba", and user's
   Bizums with copy; total card in row with 28px figure left and note right.
   Show "por cabeza" only if every purchase is consumed by everyone. "BIZUMS
   PENDIENTES" rows have circular checks. Marking one creates a real transfer
   that changes the balance; completed transfers live under "BIZUMS HECHOS" and
   can be corrected with confirmation.
   "Mandar las cuentas al grupo" in violet.
5. **Expense sheet**: direct expense, mark bought, or edit. Fields: Qué, Precio,
   compact summaries for Pagó and ¿Quiénes lo catan?, with pills revealed only
   after "Cambiar". Consumer options include Todos and Solo yo; payer options can
   suggest who should pay next to balance the group. Green save button, delete
   with confirmation, and history line.
6. **Share sheet**: before showing a shareable message, local-only parties try
   to go live, and live parties confirm they are up to date. If either fails,
   show a blocking sheet with retry and a calm note that internet is needed.
   Once live and up to date, show message preview, Copiar and WhatsApp green
   buttons, and "Mandar con otra app" when native share is available. AP2 copy
   is a backup, not normal invitation copy.
7. **Sheets and controls**: every non-blocking sheet has a visible close button,
   closes with Escape, traps focus, returns focus to its opener, and disappears
   from the accessibility tree after closing. Clickable rows are native buttons;
   destructive actions ask for confirmation and important touch targets are at
   least 44px tall.
