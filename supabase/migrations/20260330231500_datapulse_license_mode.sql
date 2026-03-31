INSERT INTO public.app_settings (key, value)
VALUES ('datapulse_license_mode', 'renewable')
ON CONFLICT (key) DO NOTHING;
