-- Allow managers/supervisors to read scoped assignment rows.
-- Needed for supervisor/manager drill-down filters that derive customer ids by salesperson ids.

DROP POLICY IF EXISTS "Leaders can view scoped customer assignments" ON public.salesperson_customer_assignments;

CREATE POLICY "Leaders can view scoped customer assignments"
  ON public.salesperson_customer_assignments
  FOR SELECT
  TO authenticated
  USING (
    (
      public.has_role(auth.uid(), 'manager')
      OR public.has_role(auth.uid(), 'supervisor')
    )
    AND salesperson_user_id = ANY(
      coalesce(
        public.get_user_scope_user_ids(auth.uid()),
        ARRAY[auth.uid()]::uuid[]
      )
    )
  );
