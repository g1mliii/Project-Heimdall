import { SignIn } from "@clerk/nextjs";
import { AuthPageShell } from "@/components/shell/AuthPageShell";

export default function SignInPage() {
  return (
    <AuthPageShell overline="Sign in" unavailable="Sign-in isn't configured for this environment.">
      <SignIn />
    </AuthPageShell>
  );
}
