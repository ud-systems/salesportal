INSERT INTO public.app_settings (key, value)
VALUES
  ('datapulse_access_code', ''),
  ('datapulse_access_expires_at', ''),
  ('datapulse_validation_url', 'https://clitxvzecgtdtracpbnt.supabase.co/functions/v1/validate-access-code')
ON CONFLICT (key) DO NOTHING;
