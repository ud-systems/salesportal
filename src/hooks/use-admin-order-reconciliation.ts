import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AdminOrderFinancialReconciliationRow = {
  order_id: string;
  shopify_order_id: string;
  order_number: string | null;
  shopify_created_at: string | null;
  financial_status: string | null;
  status_norm: string | null;
  total: number | null;
  original_total: number | null;
  current_total: number | null;
  subtotal: number | null;
  total_tax: number | null;
  eff_orig: number | null;
  eff_curr: number | null;
  eff_tax: number | null;
  crm_refunded_returned_value: number | null;
  missing_current_total: boolean | null;
  flag_reasons: string | null;
};

export function useAdminOrderFinancialReconciliationCandidates(
  fromIso: string | null,
  toIso: string | null,
  onlyFlagged: boolean,
  maxRows: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["admin-order-financial-reconciliation", fromIso, toIso, onlyFlagged, maxRows],
    enabled: enabled && Boolean(fromIso && toIso),
    queryFn: async (): Promise<AdminOrderFinancialReconciliationRow[]> => {
      const { data, error } = await supabase.rpc("get_admin_order_financial_reconciliation_candidates", {
        _from_iso: fromIso,
        _to_iso: toIso,
        _only_flagged: onlyFlagged,
        _max_rows: maxRows,
      });
      if (error) throw error;
      return (data ?? []) as AdminOrderFinancialReconciliationRow[];
    },
  });
}
