import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FALLBACK_STORE_CURRENCY } from "@/lib/format";

export function useShopDisplayCurrency() {
  return useQuery({
    queryKey: ["shop-display-currency"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "shop_display_currency")
        .maybeSingle();
      if (error) throw error;
      const v = (data?.value || "").trim().toUpperCase();
      return v && /^[A-Z]{3}$/.test(v) ? v : FALLBACK_STORE_CURRENCY;
    },
    staleTime: 300_000,
  });
}
