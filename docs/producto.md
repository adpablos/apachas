# Producto — qué mejorar en A Pachas y por qué

Especificación de producto, 2026-07-05. Parte del análisis de mercado hecho
con Codex (Tricount, Splitwise, Settle Up, Splid, Spliit, Tab, Google Pay
split), lo contrasta con el código real de `public/index.html` y deja
decisiones tomadas, no opciones abiertas. El apéndice recoge lo que el
análisis original decía mal o a medias.

## La tesis

A Pachas no compite con Tricount en completitud. Compite en una promesa más
estrecha y más valiosa para una peña:

> Lo mandas al grupo, cada uno apunta lo suyo, y al final salen los bizums.

Hoy la app cumple la mitad de esa promesa. Calcula bien (splits por
consumidores, bizums mínimos, saldos por persona) y entra bien (sin cuentas,
sin instalar, con demo). Lo que no cumple es el «cada uno apunta lo suyo»:
el enlace es una **foto** de la fiesta, no la fiesta. Cada móvil guarda su
copia y la app misma tiene que avisar de que las compras las apunte una sola
persona. Esa es la debilidad número uno; casi todo lo demás son mejoras de
segundo orden.

## Diagnóstico (por orden de daño)

1. **Colaboración por copia, no por estado vivo.** Dos personas editan copias
   distintas creyendo que «la app» está al día. Obliga al modo escriba: uno
   apunta todo y reenvía el enlace. Es lo contrario de la promesa.
2. **El enlace hace de invitación, backup y transporte de datos a la vez.**
   Enlaces kilométricos en el chat, snapshots obsoletos que pisan la fiesta
   local al abrirlos, y todo el estado de la fiesta viajando en cada mensaje.
3. **No hay gasto directo.** En fiesta real la mitad de los gastos aparecen
   después de pagarlos («he pillado hielo, 6 €»). Hoy eso son dos pasos:
   apuntar a la lista y luego «ya comprada». Además, quien no tiene la llave
   no puede decir que pagó otro.
4. **Las cuentas no responden «¿y yo qué?».** La pantalla Cuentas enseña el
   total, un «por cabeza» y los bizums de todos. Tu saldo está en otra tab
   (Peña), sin desglose. Y el «por cabeza» (total ÷ personas) es directamente
   engañoso cuando hay compras que no catan todos.
5. **WhatsApp es un `share` genérico.** Hay dos textos (invitación y cuentas)
   pero no mensajes por momento: faltan cosas, recordatorio individual con
   deuda, cierre. El texto que llega al grupo es parte del producto.
6. **La pantalla Fiesta no dice qué toca ahora.** Repite el hero y la
   identidad, pero la acción principal (apuntar gasto, resolver lista, mandar
   cuentas) hay que ir a buscarla.
7. **Sin rastro mínimo.** Un gasto no dice quién lo apuntó ni cuándo se tocó;
   borrar una compra pide confirmación implícita (está tras el sheet de
   edición) pero nada explícito. Con dinero, la confianza se apoya en poder
   auditar.

## Lecciones del mercado (condensadas)

- **Tricount** (21 M usuarios): gana por «todos ven lo mismo y todos pueden
  añadir», no por multidivisa. Es exactamente lo que nos falta.
- **Splitwise**: enseña hacia dónde NO crecer en el primer nivel (categorías,
  recurrentes, IOUs…). Copiar la claridad de balances, no la densidad.
- **Settle Up**: «quién paga ahora» encaja de lleno con lista de compra de
  fiesta — reparte la carga durante, en vez de ajustar después. P1 claro.
- **Splid**: la referencia de pacto mental — sin cuenta, local si no hay red,
  compartido cuando la hay. Nuestro norte de arquitectura.
- **Spliit**: hasta el minimalista open source tiene grupos compartidos.
  «Sin backend» ya no es diferencial; «sin cuentas» sí.
- **Tab**: OCR de tickets solo tiene sentido cuando el problema son tickets
  de bar largos y repetidos. No es nuestro caso todavía.
- **Google Pay split**: la fricción de pago en España es Bizum, y no tiene
  API. El valor está en dejar claro «tu único bizum es X a Y» y dar el texto
  hecho. No perseguir integraciones.

Sobre WhatsApp: es la puerta y el megáfono, no la superficie de edición.
Business Platform y Flows exigen cuenta business, plantillas aprobadas,
webhooks y servidor serio — fase 3 como pronto. El MVP correcto es enlace
corto + mensajes prerellenados impecables (`navigator.share` y `wa.me`).

## Decisiones

### D1. Fiesta viva por enlace, con backend mínimo propio

Se acaba el snapshot: una fiesta compartida vive en el servidor y el enlace
corto la referencia. Sin cuentas, sin usuarios, sin base de datos: un JSON
por fiesta.

- **API de un solo fichero** (`server/api.js`, Node ≥18 sin dependencias,
  igual que el frontend es un solo HTML): `POST /api/fiestas` (crear),
  `GET /api/fiestas/:id` (leer, con `?rev=` para abaratar el sondeo),
  `PUT /api/fiestas/:id` (guardar con control de revisión: 409 si llegas
  viejo, 403 sin clave de escritura).
- **Enlace**: `https://collados.alexdepablos.es/#F:<id>:<clave>`. Va en el
  *hash*, así que ni nginx ni Cloudflare ven la clave en logs. Quien tiene el
  enlace puede editar (mismo modelo de confianza que hoy); las acciones
  delicadas siguen siendo de la llave, dentro de la app.
- **El modo local no muere**: sin red, o si el servidor no está, la app
  funciona exactamente como hoy (localStorage + enlaces `AP1:` como copia).
  Una fiesta local se puede «poner en vivo» en un toque; los enlaces `AP1:`
  y `EB1:` antiguos se siguen importando.
- **Sincronización sin lenguaje técnico**: subir con retardo de medio
  segundo tras cada cambio; bajar al abrir, al volver a la app y cada ~12 s;
  «Al día hace un momento» como único indicador. Si no hay red: «Sin red;
  tus cambios se subirán solos» — y se suben.
- **Conflictos**: fusión por entidad (última escritura gana por `mod`
  timestamp; borrados con papelera de ids para que no resuciten). Con una
  peña de 5–15 personas y ediciones que son casi siempre añadir, esto
  sobra; nada de pedirle al usuario que entienda versiones.

Tradeoff asumido: deja de ser 100 % estático. A cambio, el stack sigue
siendo «dos ficheros de producto» (un HTML, un JS de servidor) y el
despliegue el mismo `compose up`. Es el cambio con más retorno de todo el
documento; lo demás son mejoras alrededor.

### D2. Un solo modelo de item, no dos colecciones

El análisis original proponía separar `shoppingItems` de `expenses`. **No.**
El modelo actual (`item.estado: pendiente | pillada | comprada`) ya modela
el ciclo planificación → gasto con un solo objeto, y es la ventaja propia de
A Pachas: la lista y las cuentas son la misma cosa vista en dos momentos.
Un «gasto directo» es simplemente un item que nace `comprada`. Separar
colecciones duplicaría UI, merge y migración sin ganancia a esta escala.

### D3. Gasto rápido como acción principal

Sheet único de gasto para los tres casos (gasto directo, marcar item de la
lista como comprado, editar compra): concepto + precio + «pagó» (yo por
defecto, cualquiera puede cambiarlo — se quita la restricción de llave al
elegir pagador) + «quiénes la catan» (todos por defecto). Guardar un gasto
entre todos = 4 acciones: botón, concepto, precio, guardar.

### D4. Cuentas que responden primero «¿y yo qué?»

Arriba del todo, tu situación: «Estás en paz» / «Debes 12,40 €» / «Te deben
8,10 €», con el desglose que la explica (pagaste X, te tocaba Y) y tu acción
concreta (a quién haces bizum / quién te lo debe). El «por cabeza» solo se
enseña cuando todas las compras son entre todos; si hay consumos parciales
se sustituye por «repartido según quién cata cada cosa». Total, bizums de
todos y compartir siguen debajo.

### D5. Kit de mensajes WhatsApp por momento

Cuatro mensajes, escritos para que el grupo actúe sin preguntar, con vista
previa antes de mandar y botón WhatsApp (`wa.me`) además de compartir/copiar:

1. **Invitación** (al crear y desde Fiesta/Peña): entra, di quién eres,
   apunta lo que pilles.
2. **Faltan cosas** (desde Lista, si hay pendientes): lista de lo que no
   tiene dueño + enlace.
3. **Cuentas** (desde Cuentas): total, bizums con ✓/·, «marca el tuyo cuando
   lo hagas» + enlace. Si está todo saldado, mensaje de cierre.
4. **Recordatorio individual** (desde la ficha de persona): lo que le toca
   traer y/o el bizum que le sale.

### D6. Fiesta → Inicio accionable

Dentro de una fiesta el hero grande sobra (ya sabes dónde estás). La
pantalla pasa a: card de la fiesta con estado de sincronización y «Mandar al
grupo» + card «¿Qué toca?» con LA acción según el estado (lista vacía →
apuntar lo que falta; cosas sin dueño → resolverlas; si no → apuntar gasto;
bizums pendientes → a cuentas) + tu saldo en una línea + identidad y enlaces
de siempre. El hero completo queda para la entrada sin fiesta.

### D7. Historial mínimo, no contabilidad

Cada item guarda quién lo apuntó y cuándo, y quién lo tocó por última vez;
el sheet de edición lo enseña en una línea. Borrar una compra con precio
pide confirmación explícita. Nada de feed de actividad en P0.

## Especificación P0

Todo lo de esta sección se implementa ya (rama de esta iteración).

### Modelo de datos (v4, evolución del actual)

```js
// Compartido (viaja al servidor y en enlaces):
{
  v: 4,
  fiesta: { nombre, fecha, mod },          // mod: ms epoch de última edición
  gente:  [{ id, nombre, admin, mod }],
  items:  [{
    id, nombre,
    estado: 'pendiente' | 'pillada' | 'comprada',
    pilladorId?,                            // solo pillada
    precio?, compradorId?, consumen?,       // solo comprada; consumen null = todos
    creadoEn?, creadoPor?, mod, modPor?,
  }],
  saldados: { 'pDe>pA': { hecho, t, por } },  // se acepta `true` legado
  papelera: [{ id, t }],                       // tombstones de gente e items
}
// Solo local (nunca se sube): yo, tab, remota: { id, clave, rev }
```

Migración v3→v4 al cargar/importar: `mod: 0`, `saldados[k] === true` →
`{hecho: true, t: 0}`, `papelera: []`. La clave de localStorage sigue siendo
`a-pachas-v1` y los enlaces `AP1:`/`EB1:` se siguen aceptando (y generando
como copia de seguridad en modo local). Los enlaces `AP1:` nuevos (v4) los
abre también la app vieja: mismas formas, campos extra ignorados.

### API

- `POST /api/fiestas` body `{estado}` → `201 {id, clave, rev:1}`.
- `GET /api/fiestas/:id[?rev=n]` → `200 {rev, estado, updatedAt}` o `304`.
- `PUT /api/fiestas/:id` body `{clave, rev, estado}` →
  `200 {rev}` · `409 {rev, estado}` (revisión vieja: fusiona y reintenta) ·
  `403` (clave mala) · `404`.
- `GET /api/salud` → `200` (healthcheck).
- Guardarraíles: JSON ≤ 256 KB, validación de forma mínima, ids
  `[a-z2-7]{10}` generados con crypto, escritura atómica (tmp + rename),
  rate limit best-effort por IP, sin contenido de fiestas en logs, fiestas
  sin tocar 8 meses se purgan.
- Despliegue: contenedor `api` (node:22-alpine, sin npm install) en el
  compose existente; nginx pasa `/api/` al contenedor y lo demás sigue
  siendo estático. En local `node server/api.js` sirve también `public/`
  para probar todo junto.

### Criterios de aceptación

1. **Fiesta viva**: Edu apunta «Hielo 6 €» en su móvil; Marta abre el enlace
   del grupo (el mismo de hace tres días) y ve el gasto sin que nadie
   reenvíe nada. Cinco personas editan la misma fiesta desde móviles
   distintos sin pisarse.
2. **Gasto rápido**: con identidad elegida, apuntar un gasto entre todos =
   4 acciones. Errores con la voz de la casa («Pon qué fue», «Ponle precio,
   que gratis no fue»).
3. **Lista**: sigue igual de simple (apuntar, me lo pido, asignar con
   llave, ya comprada) y separa visualmente pendientes de compradas.
4. **Cuentas**: lo primero que ves es tu situación y tu acción. Por cabeza
   solo cuando es verdad.
5. **WhatsApp**: los 4 mensajes salen con vista previa, share nativo, botón
   WhatsApp y copiar como último recurso.
6. **Sin red / sin servidor**: la app no se rompe; guarda local, avisa una
   vez y sube sola al volver la red.
7. **Compatibilidad**: un enlace `AP1:` viejo se importa; una fiesta local
   existente se pone en vivo en un toque; la demo nunca se sube al servidor.

## P1 — siguiente tanda (no en esta rama)

1. **«Quién paga ahora»** (Settle Up): al ir a comprar, sugerir que pague
   quien menos lleva puesto. Barato encima del saldo ya calculado.
2. **Foto de ticket** (sin OCR): comprimida en cliente, miniatura en el
   gasto. Sube confianza y corta discusiones. Requiere decidir subida al
   backend (multipart o base64 con tope).
3. **Enlace de solo lectura** (sin clave de escritura en el hash) para
   mandar cuentas a quien no debe tocar.
4. **Cantidades exactas por consumidor** (el bar: cada uno lo suyo) —
   plegado tras «más opciones», nunca en el flujo básico.
5. **Varias fiestas por móvil**: archivo, duplicar fiesta anterior
   («la caldereta del año pasado»), borrar local.
6. **Plantillas de lista** (caldereta, barbacoa, cumpleaños…): matan la
   pantalla en blanco y refuerzan la especificidad de pueblo.

## P2 — apuestas (solo con uso real demostrado)

- OCR / AI scan de tickets; parser de texto pegado del chat.
- Bot o Flows de WhatsApp (exigen Business Platform: plantillas,
  webhooks, número dedicado — no antes de tener hábito y backend rodado).
- Exportación bonita (imagen vertical para el grupo, CSV de respaldo).

## Qué NO haremos

- Cuentas de usuario, emails, teléfonos. Nunca en P0–P1.
- Categorías, multidivisa, gastos recurrentes, comentarios (densidad
  Splitwise que esta escala no paga).
- Integración Bizum por deep links no oficiales (frágil); el texto copiable
  con importe y destinatario es suficiente.
- Frameworks o build en el frontend; npm install en el backend.

## Riesgos y mitigaciones

- **El backend rompe la magia de «sin infra»** → un fichero, un JSON por
  fiesta, cero dependencias; el modo local sigue existiendo entero; enlaces
  `AP1:` siguen sirviendo de backup manual.
- **Cualquiera con el enlace edita** → aceptable para peñas (modelo actual);
  destructivo sigue tras la llave; solo-lectura en P1; ids no adivinables y
  la clave nunca llega al servidor web en claro por ir en el hash.
- **Conflictos de edición** → fusión por entidad con última-escritura-gana y
  papelera; el peor caso realista (dos editan el mismo precio a la vez) se
  resuelve en el orden de llegada y se puede corregir en un toque.
- **El server es compartido con la porra del Mundial** → el stack `collados`
  sigue aislado; el api añade un contenedor a ese proyecto y nada más; los
  guardarraíles de docs/despliegue.md se mantienen.

## Métricas (sin analítica invasiva)

De momento, las que salen gratis de los logs de nginx/api: fiestas creadas,
PUTs por fiesta (¿edita más de una persona?), 409 por fiesta (¿molestan los
conflictos?), GETs con 304 (¿el sondeo es barato?). Nada de nombres ni
contenido. Si algún día hace falta más, eventos anónimos y opt-out.

## Apéndice — correcciones al análisis original

Errores o imprecisiones del documento de Codex que conviene dejar anotados:

1. **El flujo de unirse que propone como nuevo ya existe** tal cual: sheet
   «¿Quién eres?» con pills de personas + «apúntate» + posibilidad de mirar
   sin elegir. No hay nada que construir ahí salvo mantenerlo.
2. **Proponía separar `shoppingItems` de `expenses`** — descartado (ver D2):
   el estado `pendiente|pillada|comprada` ya une planificación y gasto, y
   esa unión es justo el diferencial frente a Tricount.
3. **«El gasto directo está escondido»** es cierto, pero el dato exacto es:
   son dos pasos (apuntar + «ya comprada») y además el pagador solo lo puede
   cambiar la llave — esa restricción también hay que quitarla, no solo
   añadir el botón.
4. **«Por cabeza» hoy es engañoso de verdad**: se calcula total ÷ toda la
   peña aunque haya compras con consumidores parciales (la demo misma lo
   enseña mal: el barril no lo catan todos).
5. **Sugería `paidBy: [..]` (multi-pagador) en el modelo** — fuera de P0;
   complica el merge y la UI para un caso raro en peña (se apuntan dos
   gastos y listo).
6. **Navegación**: proponía valorar quitar la tab Peña. Se queda: es donde
   viven saldos por persona, la llave y las fichas; lo que cambia es que
   Cuentas ya no te obliga a pasar por ella para saber lo tuyo.
7. Lo que el análisis clava y este documento asume entero: fiesta viva como
   cambio nº 1, WhatsApp como megáfono y no como editor, mensajes por
   momento, cuentas centradas en «tu cuenta», nada de OCR/bot/Flows en MVP.
