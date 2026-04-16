# Servicios y herramientas de FridgeShot

Documento de referencia: qué es cada servicio, para qué lo usamos, dónde se gestiona y cuánto cuesta.

---

## 1. Vercel
**Qué es:** La plataforma donde vive la app. Es como el "servidor" que hace que fridgeshot.vercel.app funcione.

**Para qué lo usamos:**
- Publicar la app en internet (deploy)
- Ejecutar las funciones de backend (análisis de fotos, generación de recetas, chat)
- Gestionar las variables de entorno (claves privadas)

**Dónde se gestiona:** https://vercel.com → proyecto `fridgeshot`

**Coste:** Gratis (plan Hobby). Límites: 100GB de ancho de banda/mes, funciones serverless incluidas.

**Cuándo necesitarías pagar:** Si la app tiene mucho tráfico (~miles de usuarios activos). Plan Pro: 20$/mes.

---

## 2. OpenAI
**Qué es:** La IA de ChatGPT. Es el cerebro de FridgeShot.

**Para qué lo usamos:**
- **GPT-4o Vision** (`/api/analyze`): analiza las fotos de la nevera y detecta ingredientes, marcas y productos que caducan
- **GPT-4o** (`/api/recipes`): genera las 3 recetas personalizadas según los ingredientes y preferencias
- **GPT-4o-mini** (`/api/chat`): responde las preguntas del chef en tiempo real (más barato y rápido)

**Dónde se gestiona:** https://platform.openai.com

**Coste:** De pago por uso (no hay plan fijo):
- GPT-4o Vision: ~0.005€ por análisis de foto
- GPT-4o recetas: ~0.003€ por generación
- GPT-4o-mini chat: ~0.0001€ por mensaje
- Estimación: 1.000 usuarios activos/mes ≈ 15-30€/mes en OpenAI

**Variable de entorno:** `OPENAI_API_KEY`

---

## 3. Spoonacular
**Qué es:** Una base de datos de recetas reales de internet.

**Para qué lo usamos:**
- Solo cuando el usuario selecciona AirFryer o Thermomix: buscamos recetas reales como "inspiración" para que GPT-4o genere instrucciones más auténticas y precisas

**Dónde se gestiona:** https://spoonacular.com/food-api

**Coste:** Gratis hasta 150 peticiones/día. Plan de pago desde 29$/mes si creces mucho.

**Variable de entorno:** `SPOONACULAR_API_KEY`

---

## 4. Upstash Redis
**Qué es:** Una base de datos en memoria (muy rápida) que usamos como "portero" de la app.

**Para qué lo usamos:**
- **Rate limiting**: limitar cuántas veces puede usar la app cada usuario por día para evitar facturas enormes de OpenAI
  - Análisis de fotos: máx. 10/día por IP
  - Generación de recetas: máx. 30/día por IP
  - Chat: máx. 50 mensajes/día por IP

**Dónde se gestiona:** https://upstash.com → base de datos `fridgeshot-ratelimit`

**Coste:** Gratis hasta 10.000 peticiones/día. Más que suficiente para empezar.

**Variables de entorno:**
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

---

## 5. Supabase
**Qué es:** Una base de datos PostgreSQL en la nube + sistema de autenticación. Es el "cerebro de datos" de FridgeShot.

**Para qué lo usamos:**
- **Autenticación**: login con Google (gestiona toda la seguridad del login)
- **Base de datos**: guarda las recetas favoritas y preferencias de cada usuario en la nube, para que estén disponibles en cualquier dispositivo

**Tablas creadas:**
- `saved_recipes`: recetas guardadas por cada usuario (nombre, pasos, ingredientes, etc.)
- `user_preferences`: preferencias de cada usuario (tiempo, raciones, dieta, despensa)

**Dónde se gestiona:** https://supabase.com → proyecto `amniuriaesnvgagfjhre`

**Coste:** Gratis hasta 500MB de base de datos y 50.000 usuarios activos/mes. Más que suficiente para empezar. Plan Pro: 25$/mes si creces mucho.

**Variables de entorno:**
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` (clave pública, va en el frontend)
- `SUPABASE_SERVICE_ROLE_KEY` (clave privada, solo en el servidor)

---

## 6. Google Cloud Console
**Qué es:** La plataforma de Google para desarrolladores. Solo la usamos para una cosa concreta.

**Para qué lo usamos:**
- Crear las credenciales OAuth que permiten el botón "Continuar con Google" en la app
- Cuando un usuario hace clic en ese botón, Google verifica su identidad y se la comunica a Supabase

**Dónde se gestiona:** https://console.cloud.google.com → proyecto `FridgeShot`

**Coste:** Gratis. Google OAuth no tiene coste.

**Credenciales creadas:**
- Client ID: `511262334606-s3ir5buq4b4t7mto3robu2ppevodpn3s.apps.googleusercontent.com`
- Client Secret: guardado en Supabase (Authentication → Providers → Google)

---

## Resumen de costes actuales

| Servicio | Coste ahora | Cuándo pagarías |
|----------|-------------|-----------------|
| Vercel | 0€ | Con mucho tráfico |
| OpenAI | ~0€ (pocos usuarios) | Desde el primer usuario activo (~céntimos) |
| Spoonacular | 0€ | Con más de 150 usos/día de AirFryer/Thermomix |
| Upstash | 0€ | Nunca en el corto plazo |
| Supabase | 0€ | Con más de 50.000 usuarios |
| Google OAuth | 0€ | Nunca |

**Total hasta tener usuarios reales: 0€**
Solo OpenAI cobra desde el primer uso, pero son céntimos por usuario.

---

---

## 7. PostHog
**Qué es:** Una herramienta de analytics — te dice exactamente cómo usan los usuarios tu app: cuántos entran, qué hacen, dónde abandonan.

**Para qué lo usamos:**
- Ver cuántos usuarios tiene la app cada día/semana/mes
- Saber qué porcentaje de usuarios que suben una foto llegan a generar recetas (funnel de conversión)
- Ver qué features se usan más (AirFryer vs Thermomix, guardado de recetas, chat...)
- Identificar dónde abandona la gente para mejorar esos pasos

**Eventos que registramos:**

| Evento | Cuándo se dispara | Datos que guarda |
|--------|-------------------|-----------------|
| `photo_analyzed` | Al analizar una foto de nevera | Número de fotos, ingredientes encontrados |
| `recipes_generated` | Al generar las recetas | Electrodoméstico, dieta, tiempo seleccionado |
| `recipe_saved` | Al guardar una receta con ❤️ | Nombre, dificultad, tiempo |
| `recipe_unsaved` | Al quitar un guardado | Nombre de la receta |
| `chat_opened` | Al abrir el chat del chef | Nombre de la receta |
| `user_signed_in` | Al hacer login con Google | Proveedor de login |

**Identificación de usuarios:** Cuando alguien hace login con Google, PostHog asocia todos sus eventos a su cuenta — así puedes ver el historial completo de un usuario concreto.

**Dónde se gestiona:** https://posthog.com → organización `FridgeShot`

**Coste:** Gratis hasta 1.000.000 de eventos al mes. Más que suficiente para empezar.

**Project API Key:** `phc_yoR4Z9wD2moKZKKvdYsan9dmuyut74crAVxyeAidonKF`

---

## Resumen de costes actuales

| Servicio | Coste ahora | Cuándo pagarías |
|----------|-------------|-----------------|
| Vercel | 0€ | Con mucho tráfico |
| OpenAI | ~0€ (pocos usuarios) | Desde el primer usuario activo (~céntimos) |
| Spoonacular | 0€ | Con más de 150 usos/día de AirFryer/Thermomix |
| Upstash | 0€ | Nunca en el corto plazo |
| Supabase | 0€ | Con más de 50.000 usuarios |
| Google OAuth | 0€ | Nunca |
| PostHog | 0€ | Con más de 1M eventos/mes |

**Total hasta tener usuarios reales: 0€**
Solo OpenAI cobra desde el primer uso, pero son céntimos por usuario.

---

## Servicios pendientes de configurar

| Servicio | Fase | Para qué |
|----------|------|----------|
| Sentry | Fase 3 | Saber cuando algo falla en producción |
| Stripe | Fase 4 | Cobrar las suscripciones Pro (3,99€/mes · 7 días gratis) |
