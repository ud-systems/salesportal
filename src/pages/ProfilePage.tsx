import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { AlertCircle, Eye, EyeOff, Loader2, Mail, RefreshCw, User } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateAllAppQueries, clearUserFilterPresetsLocal } from "@/lib/client-cache";
import { Link, useNavigate } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

import { PushNotificationsCard } from "@/components/PushNotificationsCard";

export default function ProfilePage() {
  const { user, logout, isAdmin, refreshSessionUser } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submittingPassword, setSubmittingPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [cacheBusy, setCacheBusy] = useState(false);
  if (!user) return null;

  async function handleReloadCachedData(clearFilters: boolean) {
    setCacheBusy(true);
    try {
      await refreshSessionUser();
      await invalidateAllAppQueries(queryClient);
      if (clearFilters) clearUserFilterPresetsLocal(user.id);
      toast.success(clearFilters ? "Data and saved filters reloaded." : "Dashboard data reloaded.");
    } catch {
      toast.error("Could not reload. Try again or refresh the page.");
    } finally {
      setCacheBusy(false);
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError("");

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError("Please complete all password fields.");
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordError("New password must be different from current password.");
      return;
    }

    setSubmittingPassword(true);
    const verify = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (verify.error) {
      setSubmittingPassword(false);
      setPasswordError("Current password is incorrect.");
      return;
    }

    const updateResult = await supabase.auth.updateUser({ password: newPassword });
    setSubmittingPassword(false);
    if (updateResult.error) {
      setPasswordError(updateResult.error.message);
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    toast.success("Password updated successfully.");
  };

  return (
    <div className="w-full space-y-6 px-1">
      <div className="text-center opacity-0 animate-fade-in">
        <div className="h-20 w-20 rounded-2xl gradient-primary flex items-center justify-center mx-auto mb-4 shadow-lg">
          <span className="text-primary-foreground text-2xl font-heading font-bold">{user.initials}</span>
        </div>
        <h1 className="text-2xl lg:text-3xl font-heading font-bold text-foreground">{user.name}</h1>
        <p className="text-muted-foreground font-body text-sm mt-1 capitalize">{user.role}</p>
      </div>

      {!user.hasDbRole && !isAdmin && (
        <Alert className="rounded-xl border-warning/40 bg-warning/5 opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
          <AlertCircle className="h-4 w-4 text-warning" />
          <AlertTitle className="font-heading text-foreground">Account setup needed</AlertTitle>
          <AlertDescription className="font-body text-muted-foreground text-sm">
            You are signed in, but there is no role record in the database yet. Ask an administrator to assign your role in Settings → Users so your assignments match Shopify customer metafields (SP / referred-by).
          </AlertDescription>
        </Alert>
      )}

      <div className="card-float p-6 space-y-4 opacity-0 animate-fade-in" style={{ animationDelay: "120ms" }}>
        <div className="flex items-start gap-3">
          <Mail className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="min-w-0 text-left">
            <p className="text-xs text-muted-foreground font-body">Email</p>
            <p className="text-sm font-medium text-foreground font-body truncate">{user.email}</p>
          </div>
        </div>
        {user.salesperson_name && (
          <div className="flex items-start gap-3">
            <User className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div className="min-w-0 text-left">
              <p className="text-xs text-muted-foreground font-body">Portfolio name (Shopify match)</p>
              <p className="text-sm font-medium text-foreground font-body">{user.salesperson_name}</p>
            </div>
          </div>
        )}
        <div className="flex flex-col sm:flex-row gap-2 pt-2 justify-center">
          <Button asChild variant="outline" className="rounded-xl font-body">
            <Link to="/dashboard">Back to overview</Link>
          </Button>
          <Button
            variant="ghost"
            className="rounded-xl font-body text-muted-foreground"
            onClick={() => {
              void (async () => {
                await logout();
                navigate("/login", { replace: true });
              })();
            }}
          >
            Sign out
          </Button>
        </div>
      </div>

      <PushNotificationsCard />

      <div className="card-float p-6 space-y-3 opacity-0 animate-fade-in" style={{ animationDelay: "150ms" }}>
        <div>
          <h2 className="text-base font-heading font-semibold text-foreground">Cached data</h2>
          <p className="text-xs text-muted-foreground font-body mt-1">
            Pull fresh numbers and team scope from the server, and reload your role from the database (about a minute of cached data is cleared).
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button
            type="button"
            variant="outline"
            className="rounded-xl font-body gap-2"
            disabled={cacheBusy}
            onClick={() => void handleReloadCachedData(false)}
          >
            {cacheBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reload dashboard data
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="rounded-xl font-body text-muted-foreground"
            disabled={cacheBusy}
            onClick={() => void handleReloadCachedData(true)}
          >
            Reload and reset saved filters
          </Button>
        </div>
      </div>

      <form
        onSubmit={handleChangePassword}
        className="card-float p-6 space-y-4 opacity-0 animate-fade-in"
        style={{ animationDelay: "180ms" }}
      >
        <div>
          <h2 className="text-base font-heading font-semibold text-foreground">Change Password</h2>
          <p className="text-xs text-muted-foreground font-body mt-1">
            Update your account password securely.
          </p>
        </div>

        {passwordError && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 text-destructive text-sm font-body">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {passwordError}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium font-body text-foreground">Current password</label>
          <div className="relative">
            <Input
              type={showCurrentPassword ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="rounded-xl h-11 font-body pr-10"
              required
            />
            <button
              type="button"
              onClick={() => setShowCurrentPassword((value) => !value)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium font-body text-foreground">New password</label>
          <div className="relative">
            <Input
              type={showNewPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="rounded-xl h-11 font-body pr-10"
              required
              minLength={8}
            />
            <button
              type="button"
              onClick={() => setShowNewPassword((value) => !value)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium font-body text-foreground">Confirm new password</label>
          <div className="relative">
            <Input
              type={showConfirmPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="rounded-xl h-11 font-body pr-10"
              required
              minLength={8}
            />
            <button
              type="button"
              onClick={() => setShowConfirmPassword((value) => !value)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <Button type="submit" disabled={submittingPassword} className="w-full h-11 rounded-xl font-body font-medium gap-2">
          {submittingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submittingPassword ? "Updating password..." : "Update password"}
        </Button>
      </form>
    </div>
  );
}
