-- Add owner as an app role.
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'owner';

-- Keep existing policy/RPC checks intact by treating owner as admin-level
-- whenever code asks for has_role(..., 'admin').
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND (
        role = _role
        OR (_role = 'admin'::app_role AND role::text = 'owner')
      )
  );
$$;
