import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAccessTokenForEdgeFunctions } from "@/lib/supabase-edge-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle, RefreshCw, Bell } from "lucide-react";
import { HeaderSkeleton, TableSkeleton } from "@/components/PageSkeletons";
import {
  normalizeShopifyAdminTokenClient,
  normalizeShopifyDomainClient,
  parseEdgeFunctionErrorPayload,
} from "@/lib/shopify-credentials";

type SettingsMap = Record<string, string>;

const SETTINGS_KEYS = [
  "shopify_store_domain",
  "shopify_access_token",
  "shopify_client_id",
  "shopify_client_secret",
  "shopify_webhook_secret",
  "datapulse_access_code",
  "datapulse_access_expires_at",
  "datapulse_license_mode",
  "datapulse_validation_url",
  "sync_frequency",
  "low_stock_threshold",
  "notify_sync_complete",
  "notify_sync_error",
  "notify_low_stock",
];

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsMap>({});
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [validatingCode, setValidatingCode] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "success" | "error">("idle");
  const [licenseStatus, setLicenseStatus] = useState<"idle" | "valid" | "invalid">("idle");

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    const { data } = await (supabase as any)
      .from("app_settings")
      .select("key, value")
      .in("key", SETTINGS_KEYS);

    const map: SettingsMap = {
      sync_frequency: "manual",
      low_stock_threshold: "10",
      notify_sync_complete: "true",
      notify_sync_error: "true",
      notify_low_stock: "true",
      shopify_webhook_secret: "",
      datapulse_access_code: "",
      datapulse_access_expires_at: "",
      datapulse_license_mode: "renewable",
      datapulse_validation_url: "https://clitxvzecgtdtracpbnt.supabase.co/functions/v1/validate-access-code",
    };
    if (data) {
      for (const row of data as { key: string; value: string }[]) {
        map[row.key] = row.value;
      }
    }
    setSettings(map);
    setLoading(false);
  }

  function updateSetting(key: string, value: string) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      for (const key of SETTINGS_KEYS) {
        if (settings[key] === undefined) continue;
        let value = settings[key].trim?.() ?? settings[key];
        if (key === "shopify_store_domain") value = normalizeShopifyDomainClient(value);
        if (key === "shopify_access_token") value = normalizeShopifyAdminTokenClient(value);
        if (key === "shopify_client_secret") value = normalizeShopifyAdminTokenClient(value);
        if (key === "shopify_webhook_secret") value = normalizeShopifyAdminTokenClient(value);
        const { error } = await (supabase as any)
          .from("app_settings")
          .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
        if (error) throw error;
      }
      toast.success("Settings saved successfully");
      setConnectionStatus("idle");
    } catch (err) {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    setTesting(true);
    setConnectionStatus("idle");
    try {
      const accessToken = await getAccessTokenForEdgeFunctions();
      if (!accessToken) {
        setConnectionStatus("error");
        toast.error("Your session expired. Please sign in again.");
        return;
      }

      const domain = normalizeShopifyDomainClient(settings.shopify_store_domain || "");
      const token = normalizeShopifyAdminTokenClient(settings.shopify_access_token || "");
      const clientId = (settings.shopify_client_id || "").trim();
      const clientSecret = normalizeShopifyAdminTokenClient(settings.shopify_client_secret || "");
      if (!domain) {
        setConnectionStatus("error");
        toast.error("Store domain is required.");
        return;
      }
      if (!token && (!clientId || !clientSecret)) {
        setConnectionStatus("error");
        toast.error("Provide either Access Token OR Client ID + Client Secret.");
        return;
      }

      const { data, error } = await supabase.functions.invoke("shopify-test", {
        body: {
          shopify_store_domain: domain,
          shopify_access_token: token,
          shopify_client_id: clientId,
          shopify_client_secret: clientSecret,
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const payload = data as { success?: boolean; error?: string; errors?: string; shop?: { name?: string } } | null;
      const parsed = parseEdgeFunctionErrorPayload(data, error);
      if (parsed) {
        setConnectionStatus("error");
        toast.error(parsed);
        return;
      }

      if (error) {
        setConnectionStatus("error");
        toast.error(error.message || "Connection test failed");
        return;
      }

      if (payload?.success) {
        setConnectionStatus("success");
        toast.success(payload.shop?.name ? `Connected: ${payload.shop.name}` : "Shopify connection successful!");
      } else {
        setConnectionStatus("error");
        toast.error("Unexpected response from connection test.");
      }
    } catch {
      setConnectionStatus("error");
      toast.error("Connection test failed");
    } finally {
      setTesting(false);
    }
  }

  async function handleValidateLicenseCode() {
    const code = (settings.datapulse_access_code || "").trim().toUpperCase();
    const validationUrl = (settings.datapulse_validation_url || "").trim();
    if (!code) {
      setLicenseStatus("invalid");
      toast.error("Enter your DataPulse access code first.");
      return;
    }
    if (!validationUrl) {
      setLicenseStatus("invalid");
      toast.error("Validation URL is missing.");
      return;
    }

    setValidatingCode(true);
    try {
      const res = await fetch(validationUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = await res.json().catch(() => ({} as any));
      if (!res.ok || !payload?.valid) {
        setLicenseStatus("invalid");
        toast.error(payload?.error || "Code is invalid or expired.");
        return;
      }

      const expiresAt = String(payload.expires_at || "");
      const licenseMode = payload?.lifetime ? "lifetime" : "renewable";
      setSettings((prev) => ({
        ...prev,
        datapulse_access_code: code,
        datapulse_access_expires_at: expiresAt,
        datapulse_license_mode: licenseMode,
      }));

      const nowIso = new Date().toISOString();
      const saveRows = [
        { key: "datapulse_access_code", value: code, updated_at: nowIso },
        { key: "datapulse_access_expires_at", value: expiresAt, updated_at: nowIso },
        { key: "datapulse_license_mode", value: licenseMode, updated_at: nowIso },
      ];
      const { error } = await (supabase as any)
        .from("app_settings")
        .upsert(saveRows, { onConflict: "key" });
      if (error) throw error;

      setLicenseStatus("valid");
      toast.success(
        licenseMode === "lifetime"
          ? "Enterprise lifetime license validated. Sync remains unlocked."
          : `Code validated. License active until ${new Date(expiresAt).toLocaleString()}.`,
      );
    } catch (error: any) {
      setLicenseStatus("invalid");
      toast.error(error?.message || "Failed to validate license code.");
    } finally {
      setValidatingCode(false);
    }
  }

  if (loading) {
    return <div className="space-y-6"><HeaderSkeleton /><TableSkeleton rows={10} cols={2} /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Configure your integrations and preferences</p>
      </div>

      {/* Shopify Connection */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Settings className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Shopify Connection</CardTitle>
              <CardDescription>Connect your Shopify store to sync customers, orders, and products</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Store Domain</label>
            <Input
              placeholder="your-store.myshopify.com"
              value={settings.shopify_store_domain || ""}
              onChange={(e) => updateSetting("shopify_store_domain", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Use the permanent{" "}
              <span className="font-medium text-foreground">.myshopify.com</span> hostname only — no https://
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Access Token</label>
            <div className="relative">
              <Input
                type={showToken ? "text" : "password"}
                placeholder="shpat_xxxxxxxxxxxxxxxxxxxxxxxx"
                value={settings.shopify_access_token || ""}
                onChange={(e) => updateSetting("shopify_access_token", e.target.value)}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Custom app → API credentials → <span className="font-medium text-foreground">Admin API access token</span>{" "}
              (shpat_…). Optional if using auto-refresh via client credentials below.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Client ID</label>
              <Input
                placeholder="Shopify app client_id"
                value={settings.shopify_client_id || ""}
                onChange={(e) => updateSetting("shopify_client_id", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Client Secret</label>
              <Input
                type={showToken ? "text" : "password"}
                placeholder="Shopify app client_secret"
                value={settings.shopify_client_secret || ""}
                onChange={(e) => updateSetting("shopify_client_secret", e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            If your token expires every 24h, fill Client ID + Client Secret and the backend will auto-refresh and store a new token.
          </p>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Webhook Secret</label>
            <Input
              type={showToken ? "text" : "password"}
              placeholder="Shopify app client secret for webhook HMAC validation"
              value={settings.shopify_webhook_secret || ""}
              onChange={(e) => updateSetting("shopify_webhook_secret", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Paste your custom app webhook signing secret (usually the app client secret) so incoming webhook signatures can be verified.
            </p>
          </div>

          {connectionStatus === "success" && (
            <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 dark:bg-green-950/30 dark:text-green-400 rounded-lg p-3">
              <CheckCircle2 className="h-4 w-4" />
              Connection verified successfully
            </div>
          )}
          {connectionStatus === "error" && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
              <AlertCircle className="h-4 w-4" />
              Connection failed — check your credentials
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              onClick={handleTestConnection}
              variant="outline"
              disabled={testing || !settings.shopify_store_domain || !settings.shopify_access_token}
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Test Connection
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Sync Frequency */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-accent/50 flex items-center justify-center">
              <CheckCircle2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">DataPulse License Code</CardTitle>
              <CardDescription>
                Growth/Pro codes are renewable every 30 days. Enterprise code validates as lifetime.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Access Code</label>
            <Input
              placeholder="DPF-XXXX-XXXX-XXXX"
              value={settings.datapulse_access_code || ""}
              onChange={(e) => {
                setLicenseStatus("idle");
                updateSetting("datapulse_access_code", e.target.value.toUpperCase());
              }}
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Validation Endpoint</label>
            <Input
              placeholder="https://.../functions/v1/validate-access-code"
              value={settings.datapulse_validation_url || ""}
              onChange={(e) => updateSetting("datapulse_validation_url", e.target.value)}
            />
          </div>
          {settings.datapulse_access_expires_at && (
            <p className="text-xs text-muted-foreground">
              {settings.datapulse_license_mode === "lifetime"
                ? "License mode: Lifetime"
                : `Active until: ${new Date(settings.datapulse_access_expires_at).toLocaleString()}`}
            </p>
          )}
          {licenseStatus === "valid" && (
            <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 dark:bg-green-950/30 dark:text-green-400 rounded-lg p-3">
              <CheckCircle2 className="h-4 w-4" />
              License code is valid and sync can run.
            </div>
          )}
          {licenseStatus === "invalid" && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg p-3">
              <AlertCircle className="h-4 w-4" />
              Invalid or expired code. Sync will remain locked.
            </div>
          )}
          <Button onClick={handleValidateLicenseCode} variant="outline" disabled={validatingCode}>
            {validatingCode ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Validate Code
          </Button>
        </CardContent>
      </Card>

      {/* Sync Frequency */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-accent/50 flex items-center justify-center">
              <RefreshCw className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Sync Frequency</CardTitle>
              <CardDescription>Choose how often data is synced from your Shopify store</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Auto-Sync Schedule</label>
            <Select
              value={settings.sync_frequency || "manual"}
              onValueChange={(v) => updateSetting("sync_frequency", v)}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue placeholder="Select frequency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual only</SelectItem>
                <SelectItem value="15min">Every 15 minutes</SelectItem>
                <SelectItem value="30min">Every 30 minutes</SelectItem>
                <SelectItem value="1hour">Every hour</SelectItem>
                <SelectItem value="6hour">Every 6 hours</SelectItem>
                <SelectItem value="12hour">Every 12 hours</SelectItem>
                <SelectItem value="daily">Once a day</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">How frequently data should be pulled from Shopify automatically</p>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Low Stock Threshold</label>
            <Input
              type="number"
              min={0}
              className="w-full sm:w-64"
              value={settings.low_stock_threshold || "10"}
              onChange={(e) => updateSetting("low_stock_threshold", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Products with stock at or below this number will be flagged as low stock</p>
          </div>
        </CardContent>
      </Card>

      {/* Notification Preferences */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-accent/50 flex items-center justify-center">
              <Bell className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg">Notifications</CardTitle>
              <CardDescription>Control which in-app notifications you receive</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Sync completed</p>
              <p className="text-xs text-muted-foreground">Notify when a Shopify sync finishes successfully</p>
            </div>
            <Switch
              checked={settings.notify_sync_complete !== "false"}
              onCheckedChange={(v) => updateSetting("notify_sync_complete", String(v))}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Sync errors</p>
              <p className="text-xs text-muted-foreground">Notify when a sync encounters an error</p>
            </div>
            <Switch
              checked={settings.notify_sync_error !== "false"}
              onCheckedChange={(v) => updateSetting("notify_sync_error", String(v))}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">Low stock alerts</p>
              <p className="text-xs text-muted-foreground">Notify when a product falls below the low stock threshold</p>
            </div>
            <Switch
              checked={settings.notify_low_stock !== "false"}
              onCheckedChange={(v) => updateSetting("notify_low_stock", String(v))}
            />
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} size="lg">
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Save All Settings
        </Button>
      </div>
    </div>
  );
}
