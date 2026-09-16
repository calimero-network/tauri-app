import AccountPanel from "../components/AccountPanel";
import "./Account.css";

export default function Account() {
  return (
    <div className="account-page">
      <header className="account-page-header">
        <h1>Account</h1>
        <p>Your devices, what each one may act for, and the apps this account uses.</p>
      </header>
      <main className="account-page-main">
        <AccountPanel />
      </main>
    </div>
  );
}
