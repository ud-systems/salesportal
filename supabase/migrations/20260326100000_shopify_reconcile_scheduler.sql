-- Scheduled reconciliation for Shopify sync.
-- Runs every 15 minutes, but only triggers sync when `sync_frequency` says it is due.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

INSERT INTO public.app_settings (key, value)
SELECT 'shopify_cron_secret', gen_random_uuid()::text
WHERE NOT EXISTS (
  SELECT 1
  FROM public.app_settings
  WHERE key = 'shopify_cron_secret'
);

CREATE OR REPLACE FUNCTION public.run_shopify_reconcile_if_due()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_frequency text := 'manual';
  v_secret text := '';
  v_interval interval := null;
  v_last_started timestamptz := null;
BEGIN
  SELECT value INTO v_frequency
  FROM public.app_settings
  WHERE key = 'sync_frequency';

  v_frequency := COALESCE(NULLIF(trim(v_frequency), ''), 'manual');
  IF v_frequency = 'manual' THEN
    RETURN;
  END IF;

  IF v_frequency = '15min' THEN
    v_interval := interval '15 minutes';
  ELSIF v_frequency = '30min' THEN
    v_interval := interval '30 minutes';
  ELSIF v_frequency = '1hour' THEN
    v_interval := interval '1 hour';
  ELSIF v_frequency = '6hour' THEN
    v_interval := interval '6 hours';
  ELSIF v_frequency = '12hour' THEN
    v_interval := interval '12 hours';
  ELSIF v_frequency = 'daily' THEN
    v_interval := interval '1 day';
  ELSE
    RETURN;
  END IF;

  SELECT max(started_at) INTO v_last_started
  FROM public.sync_logs
  WHERE sync_type IN ('customers', 'orders', 'products', 'collections', 'purchase_orders');

  IF v_last_started IS NOT NULL AND (now() - v_last_started) < v_interval THEN
    RETURN;
  END IF;

  SELECT value INTO v_secret
  FROM public.app_settings
  WHERE key = 'shopify_cron_secret';

  v_secret := COALESCE(trim(v_secret), '');
  IF v_secret = '' THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://xbmpndatdanjewhwxzxr.supabase.co/functions/v1/shopify-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-shopify-cron-secret', v_secret
    ),
    body := '{}'::jsonb
  );
END;
$$;

DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT jobid
    FROM cron.job
    WHERE jobname = 'shopify_reconcile_every_15m'
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'shopify_reconcile_every_15m',
  '*/15 * * * *',
  $$SELECT public.run_shopify_reconcile_if_due();$$
);
