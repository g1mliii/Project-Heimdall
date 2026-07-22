import { SignUp } from "@clerk/nextjs";
import { AuthPageShell } from "@/components/shell/AuthPageShell";

export default function SignUpPage() {
  return (
    <AuthPageShell
      overline="Create account"
      unavailable="Sign-up isn't configured for this environment."
    >
      <SignUp />
    </AuthPageShell>
  );
}
