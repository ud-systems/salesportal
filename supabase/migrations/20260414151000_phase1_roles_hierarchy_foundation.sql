-- Phase 1 foundation: expanded roles and hierarchy primitives

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'supervisor';

CREATE TABLE IF NOT EXISTS public.sales_hierarchy_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  leader_role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_hierarchy_edges_unique UNIQUE (leader_user_id, member_user_id, leader_role),
  CONSTRAINT sales_hierarchy_edges_no_self_ref CHECK (leader_user_id <> member_user_id),
  CONSTRAINT sales_hierarchy_edges_leader_role_check CHECK (
    leader_role::text = ANY (ARRAY['manager', 'supervisor'])
  )
);

CREATE INDEX IF NOT EXISTS idx_sales_hierarchy_edges_leader ON public.sales_hierarchy_edges(leader_user_id);
CREATE INDEX IF NOT EXISTS idx_sales_hierarchy_edges_member ON public.sales_hierarchy_edges(member_user_id);

ALTER TABLE public.sales_hierarchy_edges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view hierarchy edges" ON public.sales_hierarchy_edges;
CREATE POLICY "Admins can view hierarchy edges"
  ON public.sales_hierarchy_edges
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admins can manage hierarchy edges" ON public.sales_hierarchy_edges;
CREATE POLICY "Admins can manage hierarchy edges"
  ON public.sales_hierarchy_edges
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.get_user_scope_user_ids(_user_id UUID)
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE team_scope AS (
    SELECT _user_id AS user_id
    UNION
    SELECT e.member_user_id
    FROM public.sales_hierarchy_edges e
    JOIN team_scope t ON t.user_id = e.leader_user_id
  )
  SELECT array_agg(DISTINCT user_id) FROM team_scope;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_scope_user_ids(UUID) TO authenticated, service_role;
