-- Resolve user display names for analytics/reporting without requiring admin edge functions.
-- Restricts results to caller-visible users (or all requested users for admins).

CREATE OR REPLACE FUNCTION public.get_scoped_user_display_names(
  _viewer_user_id UUID,
  _target_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  user_id UUID,
  display_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  is_admin BOOLEAN;
BEGIN
  IF _viewer_user_id IS NULL THEN
    RAISE EXCEPTION 'viewer user id is required';
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> _viewer_user_id THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  is_admin := public.has_role(_viewer_user_id, 'admin');

  RETURN QUERY
  WITH requested AS (
    SELECT DISTINCT unnest(coalesce(_target_user_ids, ARRAY[]::uuid[])) AS user_id
  ),
  visible AS (
    SELECT DISTINCT unnest(
      coalesce(public.get_user_scope_user_ids(_viewer_user_id), ARRAY[_viewer_user_id]::uuid[])
    ) AS user_id
    UNION
    SELECT _viewer_user_id
  ),
  allowed AS (
    SELECT r.user_id
    FROM requested r
    WHERE is_admin
       OR EXISTS (SELECT 1 FROM visible v WHERE v.user_id = r.user_id)
  ),
  role_names AS (
    SELECT
      ur.user_id,
      max(NULLIF(btrim(ur.salesperson_name), '')) AS role_display_name
    FROM public.user_roles ur
    INNER JOIN allowed a ON a.user_id = ur.user_id
    GROUP BY ur.user_id
  )
  SELECT
    a.user_id,
    coalesce(
      rn.role_display_name,
      nullif(btrim(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '')), ''),
      split_part(coalesce(au.email, ''), '@', 1),
      a.user_id::text
    )::text AS display_name
  FROM allowed a
  LEFT JOIN role_names rn ON rn.user_id = a.user_id
  LEFT JOIN auth.users au ON au.id = a.user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_scoped_user_display_names(UUID, UUID[])
TO authenticated, service_role;
