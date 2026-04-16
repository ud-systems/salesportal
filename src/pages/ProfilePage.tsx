import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { AlertCircle, Mail, User } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function ProfilePage() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

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
    </div>
  );
}
