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
| `--muted`       | `#62697C`                    | `#99A0B4` | secondary text, inactive icons |
| `--line`        | `#E6E8F0`                    | `#2A2E3C` | borders, dividers |
| `--primary`     | `#5A50EC`                    | `#9D96FF` | violet: buttons, active tab, action links |
| `--onprimary`   | `#FFFFFF`                    | `#1B1747` | text on primary/green/coral |
| `--primarysoft` | `#ECEAFE`                    | `#2A2750` | active pills/chips, avatars, "Me encargo" |
| `--green`       | `#087A48`                    | `#45D48F` | owed to you, bought, done check, WhatsApp |
| `--greensoft`   | `#DCF5E7`                    | `#17362A` | soft green backgrounds |
| `--coral`       | `#C7353A`                    | `#FF8080` | you owe, badge, delete |
| `--coralsoft`   | `#FDE8E8`                    | `#3D2226` | soft coral backgrounds, reserved |
| `--chip`        | `#EFF1F6`                    | `#242836` | neutral chip, "Sin responsable" |
| `--shadow`      | `0 1px 2px rgba(16,18,24,.04)` | `none` | card shadow |

Fixed in both modes: the party card is brand violet `#5A50EC` with white text;
its primary inner button is `--card` with `--primary` text; its secondary button
is translucent black `rgba(0,0,0,.16)` with white text. Sheet veil is
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
bit of humor, but not overdone. Money, access, permissions, and destructive
actions are always literal; village humor belongs in successes and celebratory
empty states.

- "Los gastos de la peña, a partes iguales. Ni pa ti ni pa mí."
- "¿Qué falta? (garrafón no)" · "Me encargo" · "Apuntar compra"
- "¿Entre quiénes se reparte?" · "Sin responsable" · "Se encarga Marta"
- "Ponle precio, que gratis no fue." · "El gasto tiene que repartirse entre al menos una persona."
- "Pon qué fue." · "Apuntado. Las cuentas ya lo saben."
- "Todo comprado. Vaya máquinas." · "Cuentas claras y el chocolate espeso."
- Sync copy must avoid technical language: "En vivo con la peña · al día hace
  un momento" with green dot, "Solo en este móvil", "Sin conexión · no se
  pueden guardar cambios", and "Necesitas internet para guardar este cambio."
  Do not
  say sync/version/conflict in user-facing copy, and do not suggest that shared
  changes are saved locally for later upload.
- Admin is "la llave" in the UI, with a discreet key icon. Do not show
  "administrador" to users.
- Access language must describe capabilities, not identity: "enlace para
  editar", "enlace solo para mirar", and "permiso del móvil creador". Never
  imply that choosing a name proves who someone is.

## Screens

1. **Fiesta, actionable home**: header with oculus + wordmark left and moon
   right; violet party card with oculus watermark, translucent white label/meta,
   white "Mandar al grupo" button, translucent "Ponerla en vivo" when local, and
   live-status line with green dot; "¿QUÉ TOCA?" card with Bricolage 18px
   statement and exactly one personalized action (own assigned item first,
   missing group items second, own Bizum third); "TU SALDO" card with large colored number
   and "Mis cuentas"; identity row with avatar and violet "Cambiar"; one
   full-width "Opciones de esta fiesta" control that opens a grouped sheet for
   recent activity, rename/date when key holder, repeating pending items, a party
   switcher, forgetting this phone's copy, and server deletion on the creator
   phone. The switcher keeps one active party and any number of remembered live
   party access pointers; it never clears the current party before the target has
   opened successfully. A returning entry screen puts "Tus fiestas" first and
   keeps create/open-link actions below. A first-time entry keeps the private-beta
   promise, three compact steps, join/create/demo, and deleted-party recovery.
2. **Lista**: subtitle "{n} cosas por resolver de {total}"; add row with violet
   button; dashed "+ Apuntar un gasto ya pagado"; cards with state chips ("Se
   encarga X" primarysoft/primary, "Sin responsable" chip/muted) and one primary
   action ("Me encargo" or "Apuntar compra"). Less common actions live under
   "Más opciones" with literal labels: "Cambiar responsable", "Dejar libre",
   and "Quitar de la lista". Bought cards open readable detail for everyone;
   only the payer or a key holder sees "Corregir compra".
3. **Peña**: avatar rows with violet initials, name, optional key, and balance
   ("le deben" green, "debe" coral, "en paz"); "Mandar al grupo"; manual add.
   Person sheet on tap, with breakdown and shareable reminder. Leaving the group
   makes someone inactive for future expenses; historical purchases, transfers,
   and balances remain visible. Inactive people appear after active people.
4. **Cuentas**: subtitle "Quién paga a quién para quedar en paz". "TU CUENTA"
   card first: Debes X / Te deben X / Estás en paz in
   Bricolage 800/32px colored text, breakdown "Pagaste · te tocaba", and user's
   Bizums with copy; total card in row with 28px figure left and note right.
   Show "por cabeza" only if every purchase is consumed by everyone. "BIZUMS
   PENDIENTES" rows have circular checks. Marking one creates a real transfer
   that changes the balance; completed transfers live under "BIZUMS HECHOS" and
   can be corrected with confirmation.
   "Mandar las cuentas al grupo" in violet.
5. **Expense sheet**: direct expense, mark bought, or edit. Fields: Qué, Precio,
   compact summaries for Quién pagó and ¿Entre quiénes se reparte?, with pills
   revealed only after clearly labelled "Cambiar" controls. Options include Todos
   and Solo yo. The form records who actually paid and never suggests changing
   that fact to balance future accounts. Green save button, verb-specific delete
   confirmation, and history line.
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
8. **Activity sheet**: newest first, plain-language actor and action, relative
   time, and a short pseudonymous phone suffix. It must state that people choose
   their identity on each phone and that A Pachas does not verify identity.
   Never expose request IDs, party IDs, write keys, revisions, or log jargon in
   normal product copy.
9. **Read-only mode**: show a visible "Solo para mirar" badge and a calm access
   note. List, group, person, and accounts views render the same truth without
   add/edit/delete/assign/complete/undo controls. Identity selection may remain
   local so "Tu cuenta" works. Accounts and reminders may be shared only with a
   `#R:` link; a disconnected saved copy cannot be reshared as live state.
10. **Feedback, privacy, and help**: the entry screen and every party tab end with
    one full-width "Comentarios e ideas" control above small Help and Privacy links.
    Its supporting copy says "Cuéntanos qué falla o qué mejorarías"; there are no
    duplicate or automatic feedback prompts. Help opens a short in-app FAQ before
    offering email. Privacy starts with a plain-language summary and keeps
    provider and retention detail expandable; it remains directly reachable at
    `#privacidad`. Feedback opens a
    warning sheet before the external Featurebase board; the warning names the
    provider and tells people never to include names, amounts, or party links.
11. **Global deletion**: only show it when this phone has the creator recovery
    capability and the current session can edit. Copy must distinguish that
    phone permission from "la llave", require the exact party name, and explain
    the seven-day recovery window.
