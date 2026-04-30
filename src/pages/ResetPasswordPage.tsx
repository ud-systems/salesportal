import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, ArrowLeft, Eye, EyeOff, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";

function hasRecoveryParamsInHash() {
  const hash = window.location.hash || "";
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  return params.get("type") === "recovery" && !!params.get("access_token");
}

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<"request" | "update">("request");
  const [error, setError] = useState("");

  const redirectTo = useMemo(() => `${window.location.origin}/reset-password`, []);

  useEffect(() => {
    if (hasRecoveryParamsInHash()) {
      setMode("update");
      return;
    }

    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        setMode("update");
      }
    })();
  }, []);

  useEffect(() => {
    if (user) {
      navigate("/dashboard", { replace: true });
    }
  }, [navigate, user]);

  const handleRequestReset = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo,
    });
    setSubmitting(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    toast.success("Password reset email sent. Open the link to create a new password.");
  };

  const handleUpdatePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (!newPassword || !confirmPassword) {
      setError("Please complete both password fields.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }

    toast.success("Password updated. You can now sign in.");
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen relative flex items-center justify-center gradient-bg px-4">
      <div className="w-full max-w-sm opacity-0 animate-slide-up">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-heading font-bold text-foreground">Reset Password</h1>
          <p className="text-muted-foreground font-body text-sm mt-1">
            {mode === "request" ? "Send reset instructions to your email" : "Create and confirm your new password"}
          </p>
        </div>

        <form
          onSubmit={mode === "request" ? handleRequestReset : handleUpdatePassword}
          className="card-float p-6 space-y-4"
        >
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 text-destructive text-sm font-body">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {mode === "request" ? (
            <div className="space-y-2">
              <label className="text-sm font-medium font-body text-foreground">Email</label>
              <div className="relative">
                <Input
                  type="email"
                  placeholder="you@udsales.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="rounded-xl h-11 font-body pl-10"
                  required
                />
                <Mail className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}

          <Button type="submit" disabled={submitting} className="w-full h-11 rounded-xl font-body font-medium gap-2">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {mode === "request"
              ? (submitting ? "Sending..." : "Send reset link")
              : (submitting ? "Updating..." : "Update password")}
          </Button>

          <Button asChild variant="ghost" className="w-full rounded-xl font-body">
            <Link to="/login" className="inline-flex items-center justify-center gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back to sign in
            </Link>
          </Button>
        </form>
      </div>
    </div>
  );
}
