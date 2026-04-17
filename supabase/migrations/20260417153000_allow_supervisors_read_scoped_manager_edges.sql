-- Allow supervisors to read manager->salesperson edges for managers in their scope.
-- This fixes supervisor manager-team drilldown filters that fetch salespeople under a selected manager.

DROP POLICY IF EXISTS "Supervisors can view scoped manager hierarchy edges" ON public.sales_hierarchy_edges;

CREATE POLICY "Supervisors can view scoped manager hierarchy edges"
  ON public.sales_hierarchy_edges
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'supervisor')
    AND leader_role = 'manager'
    AND leader_user_id = ANY(
      coalesce(
        public.get_user_scope_user_ids(auth.uid()),
        ARRAY[auth.uid()]::uuid[]
      )
    )
  );
