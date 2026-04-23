export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          id: string
          key: string
          updated_at: string | null
          value: string
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string | null
          value: string
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string | null
          value?: string
        }
        Relationships: []
      }
      shopify_customers: {
        Row: {
          account_state: string | null
          address1: string | null
          address2: string | null
          city: string | null
          country: string | null
          created_at: string | null
          customer_note: string | null
          email: string | null
          first_name: string | null
          id: string
          last_name: string | null
          locale: string | null
          name: string
          phone: string | null
          province: string | null
          referred_by: string | null
          shopify_created_at: string | null
          shopify_customer_id: string
          spend_currency: string | null
          sp_assigned: string | null
          store_name: string | null
          tags: string | null
          total_orders: number | null
          total_revenue: number | null
          updated_at: string | null
          zip: string | null
        }
        Insert: {
          account_state?: string | null
          address1?: string | null
          address2?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          customer_note?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          locale?: string | null
          name: string
          phone?: string | null
          province?: string | null
          referred_by?: string | null
          shopify_created_at?: string | null
          shopify_customer_id: string
          spend_currency?: string | null
          sp_assigned?: string | null
          store_name?: string | null
          tags?: string | null
          total_orders?: number | null
          total_revenue?: number | null
          updated_at?: string | null
          zip?: string | null
        }
        Update: {
          account_state?: string | null
          address1?: string | null
          address2?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          customer_note?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          locale?: string | null
          name?: string
          phone?: string | null
          province?: string | null
          referred_by?: string | null
          shopify_created_at?: string | null
          shopify_customer_id?: string
          spend_currency?: string | null
          sp_assigned?: string | null
          store_name?: string | null
          tags?: string | null
          total_orders?: number | null
          total_revenue?: number | null
          updated_at?: string | null
          zip?: string | null
        }
        Relationships: []
      }
      shopify_order_items: {
        Row: {
          created_at: string | null
          id: string
          order_id: string
          price: number | null
          product: string | null
          quantity: number | null
          shopify_line_item_id: string | null
          shopify_variant_gid: string | null
          sku: string | null
          variant: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          order_id: string
          price?: number | null
          product?: string | null
          quantity?: number | null
          shopify_line_item_id?: string | null
          shopify_variant_gid?: string | null
          sku?: string | null
          variant?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          order_id?: string
          price?: number | null
          product?: string | null
          quantity?: number | null
          shopify_line_item_id?: string | null
          shopify_variant_gid?: string | null
          sku?: string | null
          variant?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shopify_order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "shopify_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_orders: {
        Row: {
          created_at: string | null
          currency_code: string | null
          customer_id: string | null
          customer_name: string | null
          email: string | null
          financial_status: string | null
          fulfillment_status: string | null
          id: string
          order_note: string | null
          order_number: string | null
          processed_at: string | null
          shopify_created_at: string | null
          shopify_customer_id: string | null
          shopify_order_id: string
          subtotal: number | null
          tags: string | null
          test_order: boolean | null
          total: number | null
          total_tax: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          currency_code?: string | null
          customer_id?: string | null
          customer_name?: string | null
          email?: string | null
          financial_status?: string | null
          fulfillment_status?: string | null
          id?: string
          order_note?: string | null
          order_number?: string | null
          processed_at?: string | null
          shopify_created_at?: string | null
          shopify_customer_id?: string | null
          shopify_order_id: string
          subtotal?: number | null
          tags?: string | null
          test_order?: boolean | null
          total?: number | null
          total_tax?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          currency_code?: string | null
          customer_id?: string | null
          customer_name?: string | null
          email?: string | null
          financial_status?: string | null
          fulfillment_status?: string | null
          id?: string
          order_note?: string | null
          order_number?: string | null
          processed_at?: string | null
          shopify_created_at?: string | null
          shopify_customer_id?: string | null
          shopify_order_id?: string
          subtotal?: number | null
          tags?: string | null
          test_order?: boolean | null
          total?: number | null
          total_tax?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shopify_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "shopify_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_products: {
        Row: {
          category: string | null
          created_at: string | null
          description_html: string | null
          featured_image_url: string | null
          handle: string | null
          id: string
          shopify_product_id: string
          status: string | null
          tags: string | null
          title: string
          updated_at: string | null
          vendor: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          description_html?: string | null
          featured_image_url?: string | null
          handle?: string | null
          id?: string
          shopify_product_id: string
          status?: string | null
          tags?: string | null
          title: string
          updated_at?: string | null
          vendor?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          description_html?: string | null
          featured_image_url?: string | null
          handle?: string | null
          id?: string
          shopify_product_id?: string
          status?: string | null
          tags?: string | null
          title?: string
          updated_at?: string | null
          vendor?: string | null
        }
        Relationships: []
      }
      shopify_variants: {
        Row: {
          created_at: string | null
          id: string
          inventory_location: string | null
          price: number | null
          product_id: string
          shopify_variant_id: string
          sku: string | null
          stock: number | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          inventory_location?: string | null
          price?: number | null
          product_id: string
          shopify_variant_id: string
          sku?: string | null
          stock?: number | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          inventory_location?: string | null
          price?: number | null
          product_id?: string
          shopify_variant_id?: string
          sku?: string | null
          stock?: number | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shopify_variants_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "shopify_products"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          id: string
          po_number: string
          shopify_order_id: string | null
          supplier_name: string | null
          status: string | null
          total_amount: number | null
          currency_code: string | null
          po_date: string | null
          expected_date: string | null
          notes: string | null
          source: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          po_number: string
          shopify_order_id?: string | null
          supplier_name?: string | null
          status?: string | null
          total_amount?: number | null
          currency_code?: string | null
          po_date?: string | null
          expected_date?: string | null
          notes?: string | null
          source?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          po_number?: string
          shopify_order_id?: string | null
          supplier_name?: string | null
          status?: string | null
          total_amount?: number | null
          currency_code?: string | null
          po_date?: string | null
          expected_date?: string | null
          notes?: string | null
          source?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_shopify_order_id_fkey"
            columns: ["shopify_order_id"]
            isOneToOne: false
            referencedRelation: "shopify_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      sales_hierarchy_edges: {
        Row: {
          created_at: string
          id: string
          leader_role: Database["public"]["Enums"]["app_role"]
          leader_user_id: string
          member_user_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          leader_role: Database["public"]["Enums"]["app_role"]
          leader_user_id: string
          member_user_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          leader_role?: Database["public"]["Enums"]["app_role"]
          leader_user_id?: string
          member_user_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      salesperson_customer_assignments: {
        Row: {
          id: string
          customer_id: string
          salesperson_user_id: string
          source: string | null
          created_at: string
        }
        Insert: {
          id?: string
          customer_id: string
          salesperson_user_id: string
          source?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          customer_id?: string
          salesperson_user_id?: string
          source?: string | null
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "salesperson_customer_assignments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "shopify_customers"
            referencedColumns: ["id"]
          },
        ]
      }
      shopify_webhook_events: {
        Row: {
          id: string
          webhook_id: string
          topic: string
          shop_domain: string
          payload: Json | null
          status: string
          error_message: string | null
          received_at: string
          processed_at: string | null
        }
        Insert: {
          id?: string
          webhook_id: string
          topic: string
          shop_domain: string
          payload?: Json | null
          status?: string
          error_message?: string | null
          received_at?: string
          processed_at?: string | null
        }
        Update: {
          id?: string
          webhook_id?: string
          topic?: string
          shop_domain?: string
          payload?: Json | null
          status?: string
          error_message?: string | null
          received_at?: string
          processed_at?: string | null
        }
        Relationships: []
      }
      sync_checkpoints: {
        Row: {
          cursor: string | null
          last_completed_at: string | null
          sync_type: string
          updated_at: string
        }
        Insert: {
          cursor?: string | null
          last_completed_at?: string | null
          sync_type: string
          updated_at?: string
        }
        Update: {
          cursor?: string | null
          last_completed_at?: string | null
          sync_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      sync_logs: {
        Row: {
          completed_at: string | null
          error_message: string | null
          id: string
          records_synced: number | null
          started_at: string | null
          status: string
          sync_type: string
        }
        Insert: {
          completed_at?: string | null
          error_message?: string | null
          id?: string
          records_synced?: number | null
          started_at?: string | null
          status?: string
          sync_type: string
        }
        Update: {
          completed_at?: string | null
          error_message?: string | null
          id?: string
          records_synced?: number | null
          started_at?: string | null
          status?: string
          sync_type?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          salesperson_name: string | null
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          salesperson_name?: string | null
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          salesperson_name?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_notifications: {
        Row: {
          id: string
          user_id: string
          type: string
          title: string
          body: string | null
          entity_type: string | null
          entity_id: string | null
          payload: Json | null
          read_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: string
          title: string
          body?: string | null
          entity_type?: string | null
          entity_id?: string | null
          payload?: Json | null
          read_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: string
          title?: string
          body?: string | null
          entity_type?: string | null
          entity_id?: string | null
          payload?: Json | null
          read_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_salesperson_performance_rows: {
        Args: { _leader_user_id?: string; _leader_role?: string }
        Returns: {
          salesperson_user_id: string
          salesperson_name: string
          customers_count: number
          orders_count: number
          revenue: number
        }[]
      }
      get_scope_order_metrics: {
        Args: { _viewer_user_id: string; _from_iso?: string; _to_iso?: string }
        Returns: {
          orders_count: number
          customers_count: number
          revenue: number
          avg_order_value: number
        }[]
      }
      get_user_scope_user_ids: { Args: { _user_id: string }; Returns: string[] }
      get_salesperson_name: { Args: { _user_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "owner" | "supervisor" | "manager" | "salesperson"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "owner", "supervisor", "manager", "salesperson"],
    },
  },
} as const
