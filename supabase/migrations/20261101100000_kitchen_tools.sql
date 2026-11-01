-- "Mi cocina": utensilios que tiene el usuario (ids de KITCHEN_TOOLS en app.html / TOOLS en api/recipes.js).
-- Sustituye a la columna appliance (selector único). appliance se mantiene para migrar valores antiguos.
alter table public.user_preferences
  add column if not exists kitchen_tools jsonb not null default '[]'::jsonb;
