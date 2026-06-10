-- Ensure authenticated users can read and mark their own notifications as read.
GRANT SELECT, UPDATE ON public.user_notifications TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_user_notifications_read(_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE public.user_notifications
  SET read_at = now()
  WHERE id = ANY(_ids)
    AND user_id = auth.uid()
    AND read_at IS NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_user_notifications_read(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_user_notifications_read(UUID[]) TO authenticated;
