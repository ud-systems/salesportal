CREATE TABLE IF NOT EXISTS public.sync_checkpoints (
  sync_type text PRIMARY KEY,
  cursor text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_completed_at timestamptz
);

ALTER TABLE public.sync_checkpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view sync checkpoints"
ON public.sync_checkpoints
FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));
