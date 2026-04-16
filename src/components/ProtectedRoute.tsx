import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth, UserRole } from "@/contexts/AuthContext";
import { Loader2 } from "lucide-react";
import type { AppCapability } from "@/lib/auth-capabilities";

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: UserRole[];
  requiredCapabilities?: AppCapability[];
}

export function ProtectedRoute({ children, allowedRoles, requiredCapabilities }: ProtectedRouteProps) {
  const { user, loading, hasCapability } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  if (requiredCapabilities?.length && !requiredCapabilities.every((capability) => hasCapability(capability))) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
