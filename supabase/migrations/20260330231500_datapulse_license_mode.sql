-- DataPulseFlow license mode: renewable (30-day) or lifetime (enterprise)
INSERT INTO public.app_settings (key, value)
VALUES ('datapulse_license_mode', 'renewable')
ON CONFLICT (key) DO NOTHING;
