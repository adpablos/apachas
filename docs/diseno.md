# Diseño — A Pachas (v2)

Identidad y UI rediseñadas con Claude Design (archivo «A Pachas v2.dc.html»
del proyecto, la v1 arena queda ahí de histórico). Proyecto de diseño
(prototipo navegable, editable):
https://claude.ai/design/p/61c29d29-59f4-4f4d-8c5b-df04adba396e

Dirección: base neutra luminosa, primario violeta festivo, los números de
dinero como protagonistas absolutos (a lo Splitwise), verde = te deben,
coral = debes, y modo oscuro en tinta (nada de marrón).

## Concepto

El logo sigue siendo el óculo/rosetón circular de piedra del monasterio de
Santa María de la Sierra (Collado Hermoso), partido en 5 porciones iguales:
pagar «a pachas» es repartir entre todos. Se pinta con `currentColor`; su
color de marca es el violeta `#5A50EC`. Además de logo, se usa como marca
de agua gigante (blanco al 16 %) en la card violeta de la fiesta.

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

| Token           | Claro                        | Oscuro    | Uso |
| --------------- | ---------------------------- | --------- | --- |
| `--bg`          | `#F5F6FA`                    | `#101218` | fondo app |
| `--card`        | `#FFFFFF`                    | `#191C25` | cards, nav, sheet |
| `--ink`         | `#171A21`                    | `#EDEFF6` | texto principal |
| `--muted`       | `#6A7186`                    | `#99A0B4` | texto secundario, iconos inactivos |
| `--line`        | `#E6E8F0`                    | `#2A2E3C` | bordes, divisores |
| `--primary`     | `#5A50EC`                    | `#9D96FF` | violeta: botones, tab activa, links de acción |
| `--onprimary`   | `#FFFFFF`                    | `#1B1747` | texto sobre primary/green/coral |
| `--primarysoft` | `#ECEAFE`                    | `#2A2750` | pills/chips activos, avatares, «Me lo pido» |
| `--green`       | `#0E9256`                    | `#45D48F` | te deben, comprada, check hecho, WhatsApp |
| `--greensoft`   | `#DCF5E7`                    | `#17362A` | fondos suaves verdes |
| `--coral`       | `#E5484D`                    | `#FF8080` | debes, badge, borrar |
| `--coralsoft`   | `#FDE8E8`                    | `#3D2226` | fondos suaves coral (reservado) |
| `--chip`        | `#EFF1F6`                    | `#242836` | chip neutro «Sin dueño» |
| `--shadow`      | `0 1px 2px rgba(16,18,24,.04)` | `none`  | sombra de cards |

Fijos en ambos modos: la card de la fiesta es violeta de marca `#5A50EC`
con texto blanco (botón interior = `--card` con texto `--primary`, botón
secundario blanco translúcido `rgba(255,255,255,.16)`); velo del sheet
`rgba(13,15,22,.5)`; punto «en vivo» `#3DDC84`; toast = fondo `--ink`,
texto `--bg`. Radio de card 16px. Modo oscuro: automático por
`prefers-color-scheme` + toggle manual (luna, arriba a la derecha,
`position:absolute`) persistido en localStorage.

## Tipografía

- Display: **Bricolage Grotesque** (Google Fonts) — wordmark 800/34px
  (20px en la cabecera interior), títulos de pantalla 700/26px, títulos de
  card/sheet 700/20px (el de la card violeta de la fiesta va a 21px),
  «¿Qué toca?» 700/18px, inicial de avatar 700/16px.
- Números de dinero (siempre Bricolage 800, `tabular-nums`): «Tu cuenta»
  32px, total de cuentas 28px, «Tu saldo» del inicio 24px.
- Cuerpo: **Instrument Sans** — botones 600/15px, nombres 600/15px,
  cuerpo 400–500/14px, meta 400/13px, chips 600/12px, labels
  uppercase 600/12px con tracking 0.08em, tabs 600/11px. Los inputs van
  a 16px A PROPÓSITO: por debajo de eso, iOS hace zoom automático al
  enfocar el campo. No bajarlos.
- Fallback: pila de sistema (la app funciona sin red de fuentes).

## Voz del copy

Castellano de pueblo, con guasa pero sin pasarse:

- «Los gastos de la peña, a partes iguales. Ni pa ti ni pa mí.»
- «¿Qué falta? (garrafón no)» · «Me lo pido» · «Ya está comprada»
- «¿Quiénes lo catan?» · «Sin dueño» · «La trae Marta»
- «Ponle precio, que gratis no fue.» · «Alguien lo catará, digo yo.»
- «Pon qué fue.» · «Apuntado. Las cuentas ya lo saben.»
- «Todo comprado. Vaya máquinas.» · «Cuentas claras y el chocolate espeso.»
- Sincronización sin lenguaje técnico: «En vivo con la peña · al día hace
  un momento» (con punto verde) · «Solo en este móvil» · «Sin red. Tus
  cambios quedan apuntados y se subirán solos.» Nada de sync/versión/conflicto.
- Admin = «la llave» (icono de llave discreto, nada de "administrador").

## Pantallas

1. **Fiesta (inicio accionable)**: cabecera con óculo + wordmark a la
   izquierda y luna a la derecha · card VIOLETA de la fiesta (marca de agua
   del óculo, label/meta en blanco translúcido, botón blanco «Mandar al
   grupo», «Ponerla en vivo» translúcido si es local, línea de estado con
   punto verde cuando está en vivo) · card «¿QUÉ TOCA?» con statement en
   Bricolage 18px y UNA acción · card «TU SALDO» con el número grande
   coloreado y «Mis cuentas» · fila quién-eres con avatar y «Cambiar» como
   texto violeta · accesos (cambiar nombre/fecha si llave, empezar otra,
   ejemplo). Sin fiesta: hero grande centrado + unirse (botón violeta) /
   crear / ejemplo.
2. **Lista**: sub «{n} cosas por resolver de {total}» · añadir (botón
   violeta) · «+ Apuntar un gasto ya pagado» discontinuo · cards con chip
   («La trae X» primarysoft/primary, «Sin dueño» chip/muted) y acciones
   («Me lo pido» primarysoft, «Asignar» con borde, links pequeños) ·
   sección «YA COMPRADAS»: cards con check verde circular a la izquierda +
   «{precio} · pagó {N} · entre {n}», se editan tocándolas · enlace
   «Mandar lo que falta al grupo» si hay cosas sin dueño.
3. **Peña**: filas avatar (primarysoft con inicial violeta) + nombre
   (+llave) + saldo («le deben» verde / «debe» coral / «en paz») · «Mandar
   al grupo» · añadir a mano. Ficha por persona al tocar, con desglose y
   recordatorio compartible.
4. **Cuentas**: card «TU CUENTA» primero (Debes X / Te deben X / Estás en
   paz en Bricolage 800/32px coloreado + desglose «Pagaste · te tocaba» +
   tus bizums con copiar) · card total en fila (cifra 28px izq., nota
   der.: «por cabeza» solo si todas las compras son entre todos) · «BIZUMS
   DE TODOS» con check circular (hecho = relleno verde, fila al 55 %) ·
   «Mandar las cuentas al grupo» en violeta.
5. **Sheet de gasto** (directo, marcar comprada o editar): Qué · Precio ·
   Pagó (pills violeta) · ¿Quiénes lo catan? (pills verdes) · botón verde ·
   borrar con confirmación y línea de historial.
6. **Sheet de mandar al grupo**: vista previa del mensaje (bloque `previo`,
   enlaces AP1 abreviados) · botones Copiar / WhatsApp (verde) · «Mandar
   con otra app» si hay share nativo.
