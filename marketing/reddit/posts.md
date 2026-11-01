# Borradores Reddit — FridgeShot

Reglas generales:
- Lee las normas de cada sub antes de publicar; muchos prohíben autopromoción o exigen flair "Proyecto propio".
- Tono de creador independiente, no de marca. Contar el porqué y pedir feedback, no vender.
- Un sub por día como máximo, y responder a todos los comentarios las primeras 2 h.
- Enlace con UTM para medir en PostHog: `https://fridgeshot.app/?utm_source=reddit&utm_campaign=<sub>`
- Capturas disponibles en esta carpeta (IMG_5732–5735).

---

## r/spain / r/askspain — enfoque "proyecto personal + feedback"

**Título:** He hecho una app que te dice qué cocinar con una foto de tu nevera. ¿Me ayudáis a romperla?

**Cuerpo:**
Llevo meses abriendo la nevera, mirando 5 minutos y acabando pidiendo comida. Así que me hice una web-app:
haces una foto a la nevera (o a la despensa), la IA detecta lo que hay y te propone 3 recetas con eso.

- Gratis, sin tarjeta, funciona en el móvil sin instalar nada
- Puedes decirle tiempo, raciones, dieta, y si tienes AirFryer o Thermomix
- Te genera una foto de cómo quedaría el plato

Busco feedback sincero: ¿detecta bien vuestros ingredientes? ¿Las recetas tienen sentido o se inventa cosas?
Las fotos no se guardan.

[enlace]

---

## r/airfryer (EN) / grupos de AirFryer en español

**Título:** I built a free tool that turns a photo of your fridge into air fryer recipes

**Cuerpo:**
Snap your fridge, it detects the ingredients and gives you 3 recipes adapted to the air fryer
(times and temps included), based on what you actually have. Free, no signup needed to try.
It's a side project — would love to know if the air fryer timings feel right to you.

[enlace]

> Nota: la app está en español. Si publicas en subs en inglés, avisa en el post ("Spanish UI for now")
> o céntrate en comunidades hispanohablantes.

---

## Comunidades Thermomix (r/Thermomix, grupos de Facebook)

**Título:** Recetas para Thermomix a partir de una foto de tu nevera (gratis)

**Cuerpo:**
Le haces una foto a la nevera, detecta los ingredientes y te da 3 recetas con pasos de Thermomix
(velocidad, temperatura, tiempo). Me encantaría que alguien con Thermomix me dijera si los pasos
son realistas o hay que afinarlos.

[enlace]

---

## r/SideProject / r/IMadeThis — enfoque técnico/maker

**Título:** FridgeShot: fridge photo → 3 recipes. Vanilla JS PWA + serverless, ~€0/month until it has users

**Cuerpo:**
Stack: single-file vanilla JS PWA, Vercel serverless functions, GPT-4o vision for ingredient detection,
Supabase for auth/sync, Upstash for rate limiting. No framework, no build step.
Hardest parts: getting vision to stop hallucinating ingredients, and iOS PWA auth quirks.
Happy to answer questions — and roast the onboarding please.

[enlace]
