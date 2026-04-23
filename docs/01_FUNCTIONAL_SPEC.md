**Sea King Capital — PO Financing & AR Factoring System**

# A Question on Structure

Before writing any code, review the paragraph below. I would like you to
design and recommend the ideal architecture and repository structure for
this application, will the below accomplish that, or would you do
something different? I would like your recommendation with the full
context of the application incorporated.

ARCHITECTURE (finalized in Architecture Recommendation document):

-   Monorepo using pnpm workspaces.

-   Three apps: apps/manager (primary Manager UI), apps/client-portal
    (read-only Client views + advance request submission), apps/jobs
    (scheduled Supabase Edge Functions — fee accruals, digests,
    aged-out warnings).

-   Stack: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui for
    both UI apps; Supabase Edge Functions for jobs.

-   Shared packages/: domain/ (pure business logic, no I/O), events/
    (append-only event sourcing primitives), db/ (Supabase schema +
    migrations + generated types), retailer-parsers/ (one folder per
    retailer with subfolders for purchase-orders/, invoices/,
    payments/), bank-parsers/ (Chase now, others later), notifications/
    (Resend + templates), money/ (cents-based money type + ratable
    allocation helpers with deterministic tie-breaking), dates/
    (America/New_York timezone helpers + fee-period math), auth/, api/,
    ui/, validators/ (Zod).

-   All financial amounts stored as integer cents (bigint). All calendar
    dates stored as date (not timestamptz) anchored to America/New_York.

-   Domain-package rules: no cross-domain imports; domain logic is pure
    (no DB or HTTP calls); every ledger-affecting change is an
    append-only event; projections (current-state materialized views)
    are rebuildable from the event log alone; every domain folder has a
    README; validators live at API boundaries only.

-   Top-level CLAUDE.md provides context for Claude Code; per-domain
    READMEs keep per-turn context small.

The database schema should be designed to comprehensively and
transparently track all financial activity---including payments
received, advances issued, invoices submitted, purchase orders received,
and interest/fees accrued---in a fully auditable manner. Each
transaction and state change must be linked through clear, traceable
relationships so that the full lifecycle of any position can be
reconstructed at any time. For example, an advance that begins as a
purchase order advance and later converts into an accounts receivable
advance upon invoicing should maintain a continuous record showing: the
specific invoice that triggered the conversion; all associated payment
IDs that contributed to paying down that receivable; the exact dates on
which fees accrued and the corresponding amounts; and any excess
collections that resulted in remittances, including which remittance
records those funds were allocated to. The system should enable precise,
line-item-level visibility across all stages, ensuring that every dollar
can be traced from initial deployment through final settlement.

AUDITABILITY IMPLEMENTATION: The system will use full event sourcing.
Everything financially relevant is an append-only event (advances,
payments, remittances, fee accruals, fee collections, pre-advance
conversions, allocations, undos/reversals). Current state is a
materialized view derived from the event log — never directly mutated.
Undo is always a compensating event, never a delete. Undoing a change
that has had subsequent events built on top of it requires those
subsequent events to be undone first; the system will show a cascade
preview before executing. Reference data (clients, retailers, batches,
purchase orders, invoices, users, rule changes) lives in CRUD-able
tables, but every change is logged to a separate audit_log table. Two
types of removal are supported: Undo (reverses business effect, retains
full audit trail of happened-then-reversed) and Void (marks a record as
erroneous at source; downstream views filter it out but the original row
is retained). Optimistic locking with per-aggregate version numbers
prevents concurrent-edit conflicts; conflicting commits fail with a diff
shown to the Manager. Row-Level Security is tested, not assumed ---
every table and view has an RLS test ensuring a Client user can only see
their own data.

# High-Level Description

-   This app is built to track all prior and outstanding purchase orders
    and accounts receivable we advance on, along with payments received
    and remittances issued to our Clients

    -   At any time, we should be able to understand what principal is
        outstanding, how much fees are outstanding, what the total
        borrowing base is, and how much of the borrowing base remains
        available for our client to advance against

        -   We should be able to view these metrics at a summarized
            level, but also be able to drill down to the invoice level
            if needed

        -   It is important that we are able to export data when needed
            at both the invoice level and the summarized level

-   There will be 4 main roles

    -   Our client ('Client')

    -   Our investors ('Investors')

    -   Our creditors ('Creditors')

    -   Ourselves ('Managers')

Phase 1 scope: Build the full Manager app and a read-only Client portal
with advance request submission. Investor and Creditor roles are stubbed
--- the schema includes investors, creditors, investor_client_access,
and creditor_client_access tables with a nullable capital_source foreign
key on advances, but no UI is built for these roles in Phase 1. The app
is Sea King Capital itself; Sea King is not modeled as a counterparty
entity.

Manager sub-roles: Admin Manager (can set Borrowing Base rules, set Fee
rules, invite users, undo any change, execute write-offs, manage
per-Client access permissions) and Operator (can record advances,
payments, remittances, upload data, but cannot change rules, invite
users, or execute write-offs).

-   Our Client should be able to access the app on a permissioned basis
    to review data down to the invoice level, but in a read only
    capacity

    -   The app should be setup to handle multiple Clients, and Clients
        should be permissioned to view only their data

    -   Clients should be able to request to advance a certain amount
        based on the borrowing base shown in the portal

Terminology convention: Sea King vocabulary never uses loan terminology.
"Advance" replaces "loan" and "borrow"; "fees" replaces
"interest"; "Advance Request" replaces "Draw Request"; "Client"
replaces "borrower."

ADVANCE REQUEST WORKFLOW (Client-initiated): Client submits an Advance
Request via the portal with a dollar amount, optional invoice
attachments they want the funds to help pay, and free-text context. On
submission, an email is sent to advancerequest@seakingcapital.com with a
summary, attachments, and a link to the request in the app. The request
is created with status = pending. A Manager reviews it, selects which
batch to advance from, and approves (or rejects) it. Approval triggers
creation of one or more actual advances linked back to the request (a
single request can be fulfilled by multiple advances). Request statuses:
pending, approved, rejected, fulfilled.

-   Our Creditor should be able to access the app on a permissioned
    basis to review data at a summarized level, but in a read only
    capacity

    -   The app should be setup to handle multiple Creditors, and they
        should only be permissioned to view specific Client's data

    -   They should also see coverage metrics, such as underlying
        collateral relative to funds advanced

-   Our Investors should be able to access the app on a permissioned
    basis to review data at a summarized level, but in a read only
    capacity

    -   The app should be setup to handle multiple Investors, and they
        should only be permissioned to view specific Client's data

    -   They should also see return metrics on their contributed
        capital, such as Total Net Fees earned on this Client, Total
        Volume, etc.

-   There needs to be checks in place to make sure no errors occurred.
    For example, if $100,000 is paid to us, we need to make sure that
    $100,000 and no more or less goes through the Payment Waterfall

-   It is not unlikely or uncommon for us to need to roll back an
    update, so we need to set this up in a way that any change made to
    the data is not a 'one-way door', we can undo the change and
    return to the prior state — implemented via event sourcing (see
    Auditability Implementation above). Undo must unwind in reverse
    dependency order; any change that has been built upon by subsequent
    changes requires those subsequent changes to be undone first, with a
    clear cascade preview before execution. Fee reversal on undo: if
    fees were already collected by a waterfall before the undo, the fee
    collection is reversed and the money returns to the unapplied
    payment bucket for re-application.

# Client Selection Menu

Managers will be working with multiple Clients, and data will need to be
permissioned by Client. When logging into the app, the Manager will be
presented with all the Clients they are permissioned to work with.
Selecting a Client will bring them to the Main Interface where they can
start interacting with that Client's data.

# Main Interface

The main interface will be comprised of high-level metrics based on the
underlying data, along with buttons that will enable the Manager to
interact with the underlying data.

The high-level metrics should include the following data points, and
should be filterable by Batch:

-   Outstanding Purchase Order Value (Non-Invoiced)

-   Outstanding Purchase Order Advances

-   Current Purchase Order Borrowing Ratio

-   Purchase Order Borrowing Base Available

-   Outstanding Accounts Receivable Value

-   Outstanding Accounts Receivable Advances

-   Current Accounts Receivable Borrowing Ratio

-   Accounts Receivable Borrowing Base Available

-   Pre-Advance Accounts Receivable Principal Outstanding

-   Pre-Advance Accounts Receivable Borrowing Base Available

-   Total Outstanding Fees

-   Over Advanced status flag (with total principal over the borrowing
    base, if applicable)

-   Remittance Payable (balance accumulated and awaiting wire)

The buttons will be:

-   Set Borrowing Base and Fee Rules

-   Purchase Order Upload

-   Advance on Purchase Orders

-   Invoice Upload

-   Advance on Accounts Receivable

-   Pre-Advance on Accounts Receivable

-   Assign Purchase Orders and Invoices to a Batch

-   Record a Payment

-   Record a Remittance

-   Advances in Bad Standing (covers aged-out advances, PO-level
    over-advanced advances, and cancelled POs with outstanding
    principal)

-   View the Update Ledger

-   View and Update Underlying Data

-   Advance Requests (view and approve/reject Client-submitted requests)

-   Reports & Exports (Borrowing Base Certificate, Aging Report, Fee
    Accrual Report, Payment History, Full Ledger Export — all CSV,
    with printable report views)

-   Cancel a Purchase Order (Manager-initiated; see Purchase Order
    Cancellations section)

# Set Fee Rules

We generally charge fees based on fixed periods, and have different fee
rates depending on which fee period you are in. Here is an example of
how this typically looks:

-   The first fee period is 30 days long (including the day of the
    advance)

-   We charge our client 3% of the principal in fees for the first
    period

-   It doesn't matter if the principal on that advance is paid back on
    day 2 or day 30 of this fee period, they are still charged 3% of the
    principal at the start of the period in fees

-   Every period of 15 days thereafter they are charged an additional
    1.5% of the principal in fees. Again, it doesn't matter if we are
    paid on day 1 or 15 of the fee period, the full 1.5% of fees will be
    charged

-   The first fee period starts on the day the advance is made

Fee mechanics (confirmed during Q&A):

-   Step-function, not daily accrual. At the moment a new period begins
    (midnight America/New_York on the boundary day), the full period fee
    is recognized, added to the outstanding fee balance, and is
    immediately collectible by the next payment received. There is no
    grace period.

-   Fees are tied to an advance "series." Each distinct advance
    (identified by its own Advance Date) carries its own fee schedule
    based on its Advance Date. A single PO or invoice may carry multiple
    advance series if additional capital was extended on different
    dates.

-   Fee rate changes are applied prospectively only. Existing advances
    keep the fee schedule in effect at their Advance Date; new advances
    use the new rules. Borrowing Base rate changes, by contrast, are
    applied retroactively to all outstanding positions.

-   Fees on an aged-out advance continue to accrue at the
    subsequent-period rate. Aging out removes the underlying from the
    borrowing base but does not stop the fee clock.

In the Set Borrowing Base and Fee Rules menu, the Manager should be able
to define:

-   Days in first period

-   Days in second period

-   Days in every subsequent period

-   Fees charged during first period (as a percentage of principal)

-   Fees charged during second period (as a percentage of principal)

-   Fees charged during every subsequent period (as a percentage of
    principal)

-   One-time fees: the Manager can assess a one-time fee. Each one-time
    fee has a target_type indicating what it attaches to. Three target
    types are supported: (1) advance — attached to a specific advance
    series; (2) purchase_order or invoice — attached to a specific PO
    or invoice; (3) batch or client — attached to a Batch, or at the
    Client level. One-time fees enter the same fee bucket as periodic
    fees. Advance-, PO/invoice-, and batch-targeted one-time fees are
    collected alongside their target's existing fee priority.
    Client-level one-time fees ("house-level fees") are collected at a
    new Fee Priority 0, before any other fee priority.

The Manager should have the option to apply the fee rules to all
Batches, or just specific batches

There should be a way for the manager to view fee rules by Batch and
individual purchase order number

Fee accrual implementation (Q28): a hybrid approach. A scheduled job
runs daily at 1:00 AM America/New_York and creates fee entries in the
event log for any advance crossing into a new period that day. In
addition, a recompute function allows regeneration of fee entries from
source (advance date + fee rules in effect at the advance date + current
as-of date) — used when rules change retroactively or when a
historical correction is required.

# Set Borrowing Base Rules

In the Set Borrowing Base and Fee Rules menu, the manager will also be
able to set the limits for each type of advancing we provide. If we do
not intend to offer a certain line of advance (for example,
pre-advancing is rare), the Manager should be allowed to enter 0%. As
the underlying converts from purchase order to accounts receivable, the
borrowing bases should update automatically.

Below are how each borrowing base will be calculated

-   Purchase Order Advances

    -   This will be a percentage of the total purchase order value (on
        non-invoiced purchase orders) at a rate defined by the user in
        this menu

-   Accounts Receivable Advance

    -   This will be a percentage of outstanding invoice value at a rate
        defined by the user in this menu

    -   The user will also define how many days accounts receivable can
        be outstanding before it is considered in bad standing (i.e. 90
        days). Invoices in bad standing will not contribute to the
        borrowing base, and will have a higher priority for repayment as
        detailed in the Payment Waterfall section

-   Pre-Advancing on Accounts Receivable

    -   This will be a percentage of outstanding AR Principal in good
        standing at a a rate defined by the user in this menu

Additional borrowing-base-related configuration (confirmed during Q&A):

-   Payment waterfall split ratio: two independent inputs, "Payment
    Allocation — % to Principal" and "Payment Allocation — % to
    Fees." The two values must sum to 100%. They default to the AR
    advance rate (e.g., if AR advance rate is 80%, defaults are 80%
    principal / 20% fees), but the Manager can edit each independently.
    The two values will often equal the AR advance rate split but are
    not required to. Changes to these values apply retroactively to all
    subsequently-processed payments (prior payment allocations are not
    re-run).

-   Borrowing Base rate changes apply retroactively to all outstanding
    positions (in contrast to fee rate changes, which are prospective).

-   Over Advanced state: a Client is Over Advanced when total principal
    outstanding exceeds the current total borrowing base available (most
    commonly triggered by invoices aging out). Over Advanced is a
    Client-level state, not per-Batch. When a Client enters Over
    Advanced state: (1) the system blocks new advances until cured; (2)
    an email is sent to overadvanced@seakingcapital.com with a summary
    and a link to the Over Advanced page; (3) the Client portal displays
    an Over Advanced alert. The state automatically clears when total
    principal returns to ≤ total borrowing base (via any principal
    reduction from the waterfall); on clearing, a follow-up "cured"
    notification is sent to the Manager.

-   Aged-out advance warnings: 5 calendar days before an invoice would
    cross the aged-out threshold, the system emails the Manager a
    warning. All advances sharing the same Advance Date are grouped into
    a single email to prevent spam. A setting allows toggling these
    emails off and adjusting the lead time.

# Purchase Order Upload Methodology

In Phase 1, Managers will rely on manual uploading data into the app. In
later phases, data will be pulled in automatically (referred to in the
main interface of the app as 'Purchase Order Upload'). Certain large
retailers (such as Walmart) will have standardized CSV exports that list
all key data. Small retailers often only issue PDFs of their purchase
orders.

Our app will standardize reports from a select number of large retailers
so that their exports can be uploaded directly to our app by Managers,
and will support multiple uploads at once from different retailers. I
will attach example exports from each large retailer we want to support
for Phase 1 so we can train the app to standardize the data. This
portion of the app should be built so that we can easily roll out
updates to support more retailers. We will also need a CSV template that
Managers can manually fill in with information for retailers that are
not yet supported.

Retailer coverage at launch: Walmart and Kroger standardized parsers,
plus a generic CSV template. Each retailer's parsers live under
packages/retailer-parsers/{retailer}/{type}/ — with separate
subfolders for purchase-orders/, invoices/, and payments/. Adding a new
retailer = adding a new retailer folder with the three subfolders. Each
subfolder exports a standard parse(file) → NormalizedRecord[]
function.

-   Purchase Order Upload Tool

    -   This is the ingestion tool that will accept each retailer's
        standardized report, along with the CSV template we created
        together that can be used for small retailers

    -   The following fields need to be pulled in:

        -   Retailer (this is a required field in the CSV template, and
            auto-populated when a standardized report is uploaded)

        -   Purchase Order Number (required)

        -   Purchase Order Issuance Date

        -   Item Description (optional)

        -   Quantity Ordered (required)

        -   Unit value (required)

        -   Purchase order value (calculated)

        -   Requested delivery date (required)

        -   Delivery location (required)

        -   Upload date (generated on upload)

        -   Upload timestamp (generated on upload)

        -   Client (required — selected from the active Client
            context; persisted with the record)

        -   Cancellation status (optional, pulled from retailer CSVs
            where present — normalized values: active, cancelled,
            partial-cancel). If a previously-active PO appears on an
            upload with status = cancelled, the system routes it through
            the Purchase Order Cancellations workflow (see section
            below). Generic CSV template supports this column; the
            Manager can also manually cancel a PO via the "Cancel a
            Purchase Order" action regardless of retailer CSV
            signaling.

    -   When data is uploaded, it should give the Manager a summary of
        the changes for review, showing a table listing each of the
        fields mentioned in the prior bullet, with a row dedicated to
        each purchase order we are pulling in

    -   Above the table should be some summary metrics:

        -   Number of new purchase orders being added

        -   Total new purchase order value being uploaded

        -   Number of purchase orders being updated (this is for
            purchase orders that already existed in the app)

        -   Change in existing purchase order value

        -   Number of purchase orders newly flagged as cancelled (and
            total principal outstanding on them)

    -   The Manager should be prompted with an option to cancel the
        upload, or Proceed

    -   In instances where there is already a data entry for a specific
        purchase order number from a specific retailer, and that same
        entry exists in the new upload, the app should default to
        overwriting the fields with the newest data. Uniqueness key:
        client_id + retailer_id + po_number. The same PO number from two
        different Clients, or the same PO number reissued by a retailer
        for a different Client, will be treated as distinct records.

        -   The Manager should have the option to not overwrite in the
            summary view (a radio button that can be selected). If this
            is chosen, the original values for any duplicate purchase
            order number will remain and the new values for those
            purchase order numbers will not be filled in

    -   The original uploaded file is retained indefinitely in Supabase
        Storage for audit purposes, linked to the upload event in the
        ledger.

# Advancing Purchase Orders

In the main interface of the app, there will be an option named
'Advance on Purchase Orders' that generates an interface that allows
Managers to select the purchase orders they would like to provide
advances on. They should have a few options to select purchase orders:

-   Primary Option: Selecting purchase orders directly in an app
    interface

    -   All open purchase orders (un-invoiced) should be listed for
        selection

    -   Cancelled purchase orders are excluded from this list by
        default. A filter toggle can include them (visible only for
        reference — they cannot receive new advances).

    -   There should be filters in the interface to narrow the results:

        -   Batch

        -   Purchase Order Number

        -   Retailer

        -   Purchase Order Issuance Date

        -   Purchase Order Value

        -   Upload date

    -   There should be a Select All Option that selects all purchase
        order numbers that fit the filter criteria

-   Secondary Option: A CSV upload

    -   The CSV upload template should have two columns:

        -   Purchase Order Number

        -   Retailer

    -   Rationale: Sometimes our clients like to send us a list of the
        purchase orders they would like to request an advance on, so
        this functionality will exist to service those requests

    -   If not all purchase orders on the CSV exist in our system, the
        Manger should be alerted and the purchase orders without a match
        should be listed with an option to export them as a CSV

Once the purchase orders that we will be advancing on have been
selected, the Manager should proceed to the next menu where they can
see:

-   The total purchase order value of the selected purchase orders

-   The PO Borrowing Base of the selected purchase orders

-   The advanced principal outstanding on the selected purchase orders

-   The PO Borrowing Base Available on the selected purchase orders

-   The current Borrowing Ratio on the selected purchase orders

The manager will have the option to:

-   Advance additional capital based on a percentage of PO Borrowing
    Base Available on the selected purchase orders

-   Advance a fixed dollar amount of additional capital

The manager will also be asked to set the 'Advance Date', which will
be used to calculate fees on the new capital extended as part of this
advance

Advance lifecycle (confirmed during Q&A): an advance has two states ---
committed and funded. When the Manager commits in the app, the advance
is recorded with committed status. When the corresponding debit appears
on a bank statement (detected during bank statement ingestion), the
status updates to funded. The Manager can also manually mark an advance
as funded and enter a wire number if it is not pulled in from a bank
statement. The Advance Date set by the Manager (which should equal the
wire date) drives fee accrual; the system flags any advance where the
expected debit does not appear on the bank statement within a
configurable window.

In instances where some receivables selected have not been assigned to a
Batch, the Manager will be prompted to assign them to a Batch. There
should be two options

-   New Batch

    -   This should be "Batch #" with the next chronological number
        that hasn't been used replacing #, starting with 1

-   Existing Batch

    -   This should give you a list of all existing Batches and allow
        you to select one

    -   These purchase orders would be folded in as an expansion of that
        Batch

-   Batch ownership: a Batch belongs to exactly one Client. A Batch can
    contain POs and invoices from multiple retailers. A Batch cannot
    span multiple Clients.

The following logic should be applied to determine how the additional
advance amount is allocated:

-   Of the selected purchase orders, those with the lowest Borrowing
    Ratio (rounded to the nearest percent) shall be ratably assigned the
    balance

-   As more purchase orders become 'tied' with each other in Borrowing
    Ratio, they will also start to be assigned the remaining balance of
    the additional advance ratably

-   For avoidance of doubt, we are trying to make sure that the
    Borrowing Ratios remain as low as possible for each purchase order
    without reassigning advances from one purchase order to another

All values should be rounded to the nearest cent and formatted as
dollars. The newly assigned values should always add up to the new
advance amount

Allocation implementation: all amounts are stored as integer cents.
Ratable allocation computes each share in integer cents; the remainder
(the sum of rounding gaps) is distributed one cent at a time, largest
pre-rounding share first, ties broken by lowest target ID. This rule is
deterministic, always sums to the exact target amount, and is documented
in packages/money/.

The following logic should be applied to protect the Manager from
accidentally over extending:

-   There should be protections to alert the Manager if any advance will
    exceed 100% of its purchase order value after this update is pushed
    through

A summary of the changes should be shown, with each purchase order we
are advancing on listed as its own individual row, and the following
columns of data with totals at the bottom of the table:

-   Purchase Order Number

-   Current Total Assigned Principal

-   Total Purchase Order Value

-   Current Borrowing Ratio (rounded to the nearest hundredth of a
    percent)

-   Newly Assigned Principal

-   Pro Forma Total Assigned Principal

-   

-   Pro Forma Borrowing Ratio (rounded to the nearest hundredth of a
    percent)

The Manager will be given the option to 'Commit Changes' or 'Cancel'

Once submitted, the date of this submission will be recorded by the
system, separate from the 'Advance Date'

Any newly advanced capital will use this 'Advance Date' date as the
reference date for fee calculations

-   If multiple advances were made separately on the same purchase order
    number, each advance will be treated as a separate series with its
    own fee schedule based on the 'Advance Date' associated with each
    advance

-   For avoidance of doubt, a purchase order that had capital advanced
    on it on two separate times with two different 'Advance Dates' two
    separate fee schedules, for each advance balance respectively

# Invoice Upload Methodology

In Phase 1, Managers will rely on manual uploading data into the app. In
later phases, data will be pulled in automatically (referred to in the
main interface of the app as 'Invoice Upload'). Certain large
retailers (such as Walmart) will have standardized CSV exports that list
all key data, but small retailers will not.

Our app will standardize reports from a select number of large retailers
so that their exports can be uploaded directly to our app by Managers,
and will support multiple uploads at once from different retailers. I
will attach example exports from each large retailer we want to support
for Phase 1 so we can train the app to standardize the data. This
portion of the app should be built so that we can easily roll out
updates to support more retailers. We will also need a CSV template that
Managers can manually fill in with information for retailers that are
not yet supported.

-   Invoice Upload Tool

    -   This is the ingestion tool that will accept each retailer's
        standardized report, along with the CSV template we created
        together that can be used for small retailers

    -   The following fields need to be pulled in:

        -   Retailer (this is a required field in the CSV template, and
            auto-populated when a standardized report is uploaded)

        -   Purchase Order Number (required)

        -   Invoice Number (required)

        -   Invoice Value (required)

        -   Invoice Approval Status (optional)

        -   Invoice Due Date (sometimes calculated, sometimes declared,
            depending on retailer)

        -   Goods Delivery Date (optional)

        -   Goods Delivery Location (optional)

        -   Item Description (optional)

        -   Upload date (generated on upload)

        -   Upload timestamp (generated on upload)

        -   Client (inherited from the parent PO)

Partial invoicing (confirmed during Q&A): a single PO may be split
across multiple invoices. A single invoice may cover multiple POs. When
an invoice is uploaded that does not cover the full PO value, the PO is
split into a "still-PO" portion (remaining uninvoiced value) and an
"AR" portion (invoiced). The Manager can continue to advance on the
still-PO portion at the PO advance rate and on the AR portion at the AR
advance rate. Any existing advances on that PO are re-allocated pro-rata
by value between the still-PO and AR portions; the Manager can override
this allocation.

-   When data is uploaded, it should give the Manager a summary of the
    changes for review, showing a table listing each of the fields
    mentioned in the prior bullet, with a row dedicated to each invoice
    we are pulling in

-   Above the table should be some summary metrics:

    -   Number of new invoices being added

    -   Total new accounts receivable value being uploaded (same as
        invoice value)

    -   Number of purchase order advances converting to accounts
        receivables advances

    -   Change in value between purchase order value and invoice value
        for the purchase order advances converting to receivables
        advances

-   Under-invoicing alert: if any incoming invoice's value is less than
    the existing advance on its parent PO, the Manager is alerted with a
    flag "over-advanced on conversion." The upload is allowed to
    proceed; the advance enters an over-advanced state and requires
    remediation. The Manager has the option to shift the over-advance
    balance to a different PO in the batch with eligible borrowing base
    availability. Shifted balance retains its original Advance Date
    (since that is when the capital was actually advanced). A marker
    indicates that the balance was shifted, with a link back to its
    original source for audit.

-   The Manager should be prompted with an option to cancel the upload,
    or Proceed

-   In instances where there is already a data entry for a specific
    purchase order number from a specific retailer, and that same entry
    exists in the new upload, the following should happen:

    -   If that purchase order number is currently classified as a
        purchase order advance, it should automatically be converted to
        an accounts receivable advance as part of the upload

        -   A key note, the Batch stays through conversion. Both
            purchase order advances and accounts receivable advances can
            belong to the same Batch.

    -   If that purchase order number is already classified as an
        accounts receivable advance, the app should default to
        overwriting the fields with the newest data

        -   The Manager should have the option to not overwrite in the
            summary view (a radio button that can be selected). If this
            is chosen, the original values for any purchase order number
            already classified as an invoice will remain and the new
            values for those purchase order numbers will not be filled
            in. For the avoidance of doubt, purchase order numbers that
            were classified as purchase order advances should still be
            updated - this only extends to purchase order numbers that
            were already classified as accounts receivable

-   The original uploaded file is retained indefinitely in Supabase
    Storage for audit purposes, linked to the upload event in the
    ledger.

# Advancing Accounts Receivable

In the main interface of the app, there will be an option named
'Advance on Accounts Receivable' that generates an interface that
allows Managers to select the accounts receivable (purchase order
numbers with an associated invoice) they would like to provide advances
on. They should have a few options to select accounts receivable:

-   Primary Option: Selecting accounts receivable directly in an app
    interface

    -   All accounts receivable (open invoices) should be listed for
        selection.

    -   There should be filters in the interface to narrow the results:

        -   Batch

        -   Purchase Order Number

        -   Retailer

        -   Invoice Value

        -   Invoice Date

        -   Expected Payment Date

        -   Upload Date

    -   There should be a Select All Option that selects all purchase
        order numbers that fit the filter criteria

-   Secondary Option: A CSV upload

    -   The CSV upload template should have two columns:

        -   Purchase Order Number

        -   Retailer

    -   Rationale: Sometimes our clients like to send us a list of the
        purchase order numbers they would like to request an advance on,
        so this functionality will exist to service those requests

    -   If not all purchase order numbers on the CSV exist in our
        system, the Manger should be alerted and the purchase orders
        without a match should be listed with an option to export them
        as a CSV

Once the accounts receivable that we will be advancing on have been
selected, the Manager should proceed to the next menu where they can
see:

-   The total invoice value of the selected receivables

-   The AR Borrowing Base of the selected receivables

-   The advanced principal outstanding on the selected receivables

-   The AR Borrowing Base Available on the selected receivables

-   The current Borrowing Ratio on the selected receivables

The manager will have the option to:

-   Advance additional capital based on a percentage of AR Borrowing
    Base Available on the selected receivables

-   Advance a fixed dollar amount of additional capital

The manager will also be asked to set the 'Advance Date', which will
be used to calculate fees on the new capital extended as part of this
advance

In instances where some receivables selected have not been assigned to a
Batch, the Manager will be prompted to assign them to a Batch. There
should be two options

-   New Batch

    -   This should be "Batch #" with the next chronological number
        that hasn't been used replacing #, starting with 1

-   Existing Batch

    -   This should give you a list of all existing Batches and allow
        you to select one

    -   These receivables would be folded in as an expansion of that
        Batch

The following logic should be applied to determine how the additional
advance amount is allocated:

-   Of the selected receivables, those with the lowest Borrowing Ratio
    (rounded to the nearest percent) shall be ratably assigned the
    balance

-   As more receivables become 'tied' with each other in Borrowing
    Ratio, they will also start to be assigned the remaining balance of
    the additional advance ratably

-   For avoidance of doubt, we are trying to make sure that the
    Borrowing Ratios remain as low as possible for each receivable
    without reassigning advances from one purchase order to another

All values should be rounded to the nearest cent and formatted as
dollars. The newly assigned values should always add up to the new
advance amount

The following logic should be applied to protect the Manager from
accidentally over extending:

-   There should be protections to alert the Manager if any advance will
    exceed 100% of its receivable value after this update is pushed
    through

A summary of the changes should be shown, with each invoice we are
advancing on listed as its own individual row, and the following columns
of data with totals at the bottom of the table:

-   Purchase Order Number

-   Invoice Number

-   Current Total Assigned Principal

-   Total Invoice Value

-   Current Borrowing Ratio (rounded to the nearest hundredth of a
    percent)

-   Newly Assigned Principal

-   Pro Forma Total Assigned Principal

-   

-   Pro Forma Borrowing Ratio (rounded to the nearest hundredth of a
    percent)

The Manager will be given the option to 'Commit Changes' or 'Cancel'

Once submitted, the date of this submission will be recorded by the
system, separate from the 'Advance Date'

Any newly advanced balance will use the 'Advance Date' as the
reference date for fee calculations

-   If multiple advances were made separately on the same purchase order
    number, each advance will be treated as a separate series with its
    own fee schedule

-   For avoidance of doubt, a purchase order number converting from a
    purchase order advance to a receivables advance that did not have
    any additional capital advanced on it would retain its original
    purchase order 'Advance Date' for fee calculations even after
    conversion

    -   If there was additional capital extended as part of the
        conversion, the original balance would continue to use its
        original purchase order 'Advance Date' for fee calculations
        after conversion, and the newly advanced capital would use the
        'Advance Date' of the newly advanced capital as its fee
        calculation date, meaning there would be two separate 'series'
        of fees on the same purchase order number

# Assign Purchase Orders and Invoices to a Batch

In addition to the opportunity to assign purchase orders and receivables
to a Batch while submitting an advance, the 'Assign Purchase Orders and
Invoices to a Batch' menu will allow you to assign them (and reassign
them) as well. The workflow should be as follows:

A table lists all outstanding purchase orders and invoices, with the
following fields and the ability to filter by them:

-   Type (Pre-Advance, Purchase Order Advance, Accounts Receivables
    Advance)

-   Purchase Order Number

-   Invoice Number

-   Batch

-   Purchase Order Value

-   Invoice Value

-   Borrowing Base

-   Available Borrowing Base

-   Accrued Fees

-   Delivery Date

-   Receivables Days Outstanding

-   Expected Paid Date

The Manager will have the option to select individual, multiple, or all
rows that fit the filter criteria, and assign them to either:

-   An existing Batch (all existing Batches will be listed)

-   A new Batch

    -   This should be "Batch #" with the next chronological number
        that hasn't been used replacing #, starting with 1

If a purchase order or invoice that is selected already carries a
balance, the Manager will be alerted with a message and given the option
to proceed or cancel:

-   Are you sure you want to proceed? Some purchase orders selected have
    already been assigned to a different batch

Once submitted, the 'Batch' field assigned to that purchase order
number will be updated with what was submitted

# Pre-Advancing on Accounts Receivable

We will sometimes advance based on expected future Accounts Receivable,
we refer to this as pre-advancing on accounts receivable. These will be
treated a differently than a standard accounts receivable advance, and
will require a different workflow. In the main interface of the app,
there will be an option named 'Pre-Advance on Accounts Receivable'
where the Manager can extend pre-advances.

In the Pre-Advance on Accounts Receivable menu, the Manager will be
shown high-level metrics:

-   Total Invoice Value

-   Total AR Borrowing Base

-   Total AR Principal Outstanding

-   Pre-Advanced Principal Outstanding

-   Pre-Advance Accounts Receivable Borrowing Base Available

As part of the same menu, the Manager will be able to enter a dollar
value for the amount they would like to pre-advance on that Batch, along
with the 'Advance Date'. Data validation will require the dollar value
to be less than or equal to the Pre-Advance Accounts Receivable
Borrowing Base Available.

Submitting the pre-advance will add a row to the ledger classified as a
pre-advance, with the 'Advance Date' of the pre-advance used as the
fee calculation date

-   For avoidance of doubt, each submitted pre-advance should be treated
    independently and have its own fee schedule based on its own
    'Advance Date'

-   There can be multiple 'series' of pre-advances assigned to the
    same batch

When invoices are assigned to the same Batch as an outstanding
pre-advance, pre-advanced principal should automatically convert into
principal at the lesser of:

-   The remaining Pre-Advanced Principal

-   The AR Borrowing Base Available on that invoice

This will effectively convert pre-advances to accounts receivable
advances, creating a pathway for their repayment. The 'Advance Date'
of the pre-advance should associated with the post-conversion accounts
receivable advance, as that is the date that the capital was originally
extended

Conversion order (confirmed during Q&A): when multiple new invoices
arrive in a batch with outstanding pre-advances, conversion is allocated
to invoices in descending order of eligible AR borrowing base. Example:
if $100 of pre-advances are outstanding in Batch 1 and three invoices
are added with $80, $60, and $40 of eligible borrowing base
respectively, $80 is assigned to the first invoice and the remaining
$20 to the second. Ties on eligible borrowing base are resolved
ratably. If multiple pre-advance series exist in the batch, conversion
applies to the oldest pre-advance series first (earliest Advance Date).
The original pre-advance Advance Date carries through conversion.

# Record a Payment

In Phase 1, Managers will rely on manual uploading data into the app. In
later phases, data will be pulled in automatically (referred to in the
main interface of the app as 'Invoice Upload'). Certain large
retailers (such as Walmart) will have standardized CSV exports that list
all key data, but small retailers will not.

Our app will standardize reports from a select number of large retailers
so that their exports can be uploaded directly to our app by Managers,
and will support multiple uploads at once from different retailers. I
will attach example exports from each large retailer we want to support
for Phase 1 so we can train the app to standardize the data. This
portion of the app should be so that we can easily roll out updates to
support more retailers. We will also need to support CSV uploads of bank
statements, along with the ability to tie payments back to specific
purchase order numbers or batches at the Manager's choosing

## Step 1: Upload Bank Statement (Required)

The purpose of this tool is to ingest data from the bank to determine
what payments were received, when, and by who. For some retailers, this
is all the information we will get, and we will need to manually tie it
back to either specific purchase orders or a general batch.

Input: The Manager will be required to upload a bank statement.

-   We will use the Chase bank statement as the Phase 1 standard
    statement.

The tool will pull the following fields for each transaction:

-   Transaction Date

-   Transaction Description

-   Transaction Amount

In addition, each bank transaction is classified by its type (derived
from description patterns):

-   ACH credit / wire credit → incoming payment candidate

-   Outgoing wire with "REMITTANCE" in memo → informational only (the
    Manager records remittances manually in the "Record a Remittance"
    tool, not via bank-statement reconciliation). Flag for Manager
    review.

-   Outgoing wire with advance-funding memo text ("ADVANCE", "DRAW",
    or other patterns used historically) → informational only, used to
    mark outgoing-advance funding if the corresponding advance exists.
    The parser recognizes both "ADVANCE" and legacy "DRAW" memo
    conventions since both appear in historical Chase statements. Flag
    for Manager review.

-   Internal account transfer ("Online Transfer to CHK...") → ignored
    by default.

The tool will derive the following field:

-   Retailer

    -   The tool will use predefined text-matching rules per retailer

        -   Example: If description contains "Walmart Inc." then
            assign retailer = Walmart

    -   If no match: retailer = null

        -   The manager will have the ability in the tool interface to
            edit the retailer field manually

-   A bank upload ID should be autogenerated and shared by all bank
    transactions in the same upload

-   A bank transaction ID should be autogenerated for each individual
    bank transaction

After ingesting the data, the tool will show the manager an interface
listing a row for each bank transaction and allow the manager to make
manual edits before moving on to the next step

The original bank statement file is retained indefinitely in Supabase
Storage for audit purposes, linked to the bank upload ID.

## Step 2: Retailer Payment CSV Upload (Optional)

The larger retailers will have standardized reports that say which
purchase orders/invoices were paid, when, and how much. This data is
helpful, as it allows us to accurately subdivide a bank transaction
amongst the invoices that were paid. Tying this information back to the
bank statement CSV is still important, as the date listed there will
indicate the date the funds actually hit our account. This is the date
we will truly record the payment as received, and it is often different
than the paid date listed on the retailer payment CSV.

Input: The Manager will have the opportunity to upload one or more
retailer payment CSVs.

Each retailer payment CSV should contain the following fields:

-   Purchase Order Number

-   Invoice number

-   Payment Date

-   Invoice Date

-   Invoice Amount

-   Discounts Applied

-   Paid Amount

-   Deductions / Chargebacks (optional, may appear as separate negative
    line items or inferred from Invoice Amount − Discounts − Paid
    Amount)

Deductions / chargebacks (confirmed during Q&A): when a retailer deducts
from a payment for reasons like shortages, damages, OTIF fines, or other
chargebacks, the system models each deduction as a separate
"deduction" record linked to the invoice, with a category (shortage,
damage, OTIF fine, pricing, promotional, other) and a free-text memo.
The net paid amount (Invoice Amount − Discounts − Deductions) is what
the system uses as funds actually received. Deductions reduce the
invoice's eligible borrowing base at the time they are known (typically
when payment is received). A deductions report (deductions by category
by retailer over a date range) is exposed in Reports & Exports.

Processing: Normalize all retailer CSVs into a standard schema

Group payments by:

-   retailer

-   Payment Date

Matching Logic (Deterministic):

For each bank statement line item:

Match when:

-   bank.retailer == payment.retailer

-   bank.transaction_amount == SUM(payment.paid_amount WHERE same
    retailer + payment_date)

If both conditions are true:

-   Match the corresponding payment.amount_paid with the
    bank.transaction_date to bring in the day the money actually hit our
    account

-   Ascribe the bank upload Id and bank transaction ID to the
    corresponding purchase order number in the main purchase order
    tracker. This will allow us to trace back which payment came in to
    pay off this purchase order

Two-pass matching (confirmed during Q&A): the matching logic runs in two
passes. Pass 1: strict match — exact-to-the-penny sum match between
bank credit and retailer CSV group (same retailer, same payment date).
Matches are flagged "auto-matched (strict)." Pass 2: fuzzy fallback
for unmatched bank credits — same retailer, payment date within ±1 day
of bank posting date, sum match within $1.00. Matches are flagged
"auto-matched (fuzzy)" and surfaced prominently in the review UI.
Anything still unmatched requires manual assignment by the Manager.

## Step 3: Payment Review and Assignment Interface

Once data has been brought in, the Manager should see an interface that
shows each bank line item, with the following values

-   Transaction Date

-   Description

-   Retailer

-   Amount

-   Status

    -   The four status options are 'Matched', 'Batch Applied',
        'Remittance' and 'Ignored'

        -   If Step 2 matched purchase orders to this deposit, the
            status should be pre-set to 'Matched'

        -   The default value otherwise should be 'Ignored'

    -   The status should always be editable

    -   When selecting 'Matched', an interface should pop up allowing
        you to select the open purchase order number(s) that this
        payment should apply to

    -   When selecting 'Batch Applied', an interface should pop up
        allowing you to select which existing Batch to apply this
        payment to

    -   When 'Remittance' is selected, 100% of the deposit will be
        treated as a value to be remitted

    -   When 'Ignored' is selected, the value will be ignored

        -   Excluded from all downstream calculations

        -   No impact on PO status or remittance flows

Per-payment waterfall override: the Manager may toggle a "Principal
Only" override on any Matched or Batch Applied payment. When checked,
100% of the payment is routed through the principal priority list (the
normal fee/principal split is bypassed). This is used when a Client
wires money specifically to cure an Over Advanced state. The override is
logged as an event in the ledger so the deviation from normal waterfall
is visible in audit.

### Design Requirements

All auto-matches must be:

-   Transparent

-   Editable

-   Auditable

Matching must be:

-   Strict (exact sum match to the penny) on Pass 1; fuzzy (±1 day,
    within $1.00) on Pass 2

-   Deterministic before allowing manual overrides

System must allow:

-   Partial completion (not all items need assignment)

-   Forward progression without blocking

### Finalization: Apply Payment Recognition

When user confirms:

If Status = Matched

-   The specific purchase orders listed get set to Paid

If Status = Batch Applied

-   Apply batch-level payment logic

-   Update batch balances accordingly

If Status = Remittance

-   Route full balance to remittance payout workflow

-   No PO-level updates

If Status = Ignored

-   No action taken

# Invoice Level Payment Waterfall (Remittance Logic)

-   This logic applies to payments received that can be attributed to
    specific purchase order numbers

-   100% of all collections received will be applied to the advance
    until all outstanding fees and outstanding principal for all
    Advances are paid in full.

    -   No Client remittance will be made until all advances reach a
        zero balance

    -   Once all fees and principal have been fully satisfied, any
        excess collections will be remitted to the Client

-   Allocation Between Fees and Principal

    -   Each incoming payment will be allocated between fees and
        principal using a predefined ratio tied to the borrowing
        structure.

    -   This ratio is set by the two independent inputs "Payment
        Allocation — % to Principal" and "Payment Allocation — %
        to Fees" in the Borrowing Base Rules menu (the two must sum to
        100%). The defaults are pre-populated from the AR advance rate
        but can be edited independently. If a Manager applies a
        Principal Only override on a payment (see Step 3 above), the
        split is bypassed for that payment and 100% is routed to
        principal priorities.

    -   Payments are therefore split between:

Waterfall execution model (confirmed during Q&A, "Model A"): each
incoming payment is split once at the top of the waterfall. The
fee-earmarked portion runs through Fee Priorities 0-7 below. Any
leftover fee-earmarked money after Fee Priority 7 is then applied
through Principal Priorities 1-5 (starting from Priority 1). The
principal-earmarked portion runs through Principal Priorities 1-5. Any
leftover principal-earmarked money after Principal Priority 5 is then
applied through Fee Priority 6 (oldest invoice fees). Order of
execution: fee-earmarked pass runs first (including any cascade into
principal priorities), then principal-earmarked pass runs. A single
payment does not re-split after money hops buckets. When everything is
satisfied, the remainder becomes Remittance (Principal Priority 7 / end
state).

-   fee repayment portion

    -   Payments earmarked for fee repayment should be paid down in this
        order:

        -   Priority 0: Client-level one-time fees ("house-level
            fees") not attached to any specific advance, PO, invoice,
            or batch

        -   Priority 1: Outstanding fees on the paid invoice

        -   Priority 2: Outstanding fees on purchase orders that have
            aged out of eligibility

        -   Priority 3: Outstanding principal on purchase orders that
            have aged out of eligibility

        -   Priority 4: Outstanding fees on purchase orders whose
            invoice was paid by the customer but still carry a balance

        -   Priority 5: Outstanding principal on purchase orders whose
            invoices were paid by the customer but still carry a balance

        -   Priority 6: Outstanding fees on the oldest invoices in the
            same batch as the invoice paid

        -   Priority 7: Outstanding fees on the oldest invoices
            outstanding in any batch

        -   Cascade: if nothing matches Priorities 0-7, remaining
            fee-earmarked money is applied through the Principal
            Priorities (starting at Principal Priority 1) — it does
            NOT re-split; the full remaining amount cascades.

-   principal repayment portion — maintains the intended relationship
    between outstanding principal and underlying collateral.

    -   Payments earmarked for principal repayment should be paid down
        in this order

        -   Priority 1: Principal on the paid invoice

        -   Priority 2: Outstanding principal on purchase orders that
            have aged out of eligibility

        -   Priority 3: Outstanding principal on purchase orders whose
            invoice was paid by the customer but still carries a balance

        -   Priority 4: Principal from oldest invoices in the same batch
            as the invoice paid

        -   Priority 5: Principal from oldest invoices outstanding in
            any batch

        -   Priority 6: Fees from oldest invoices outstanding in any
            batch

        -   Priority 7: If the balance of all principal and fees is 0,
            the remaining funds will be remitted to the Client

# Batch-Level Payment Logic

-   This logic applies to payments received that are attributed a batch
    rather than specific purchase orders

-   100% of all collections received will be applied to the advance
    until all outstanding fees and outstanding principal for all
    Advances are paid in full.

    -   No Client remittance will be made until all advances reach a
        zero balance

    -   Once all fees and principal have been fully satisfied, any
        excess collections will be remitted to the Client

-   The portion of batch applied payments earmarked for principal
    repayment should reduce each outstanding purchase order number
    matching the priority level of the payment (described below) ratably

    -   For example, if there are 3 $100 advances and 1 $200 advance
        in a Batch matching the same priority criteria and a $100
        batch-applied payment is recorded, with 100% of the payment
        going to pay principal (for simplicity, we are assuming all fees
        have already been paid):

    -   The $200 advance should be reduced by $40

    -   Each of the $100 advances should be reduced by $20

-   The portion of batch applied payments earmarked for fee repayment
    should reduce each outstanding purchase order number matching the
    priority level of the payment (described below) ratably

    -   Same logic as the batch applied principal payment logic

-   Allocation Between Fees and Principal

    -   Each incoming payment will be allocated between fees and
        principal using a predefined ratio tied to the borrowing
        structure.

    -   This ratio is set by the two independent inputs "Payment
        Allocation — % to Principal" and "Payment Allocation — %
        to Fees" in the Borrowing Base Rules menu.

    -   Payments are therefore split between:

        -   fee repayment portion

            -   Payments earmarked for fee repayment should be paid down
                in this order:

                -   Priority 0: Client-level one-time fees
                    ("house-level fees")

                -   Priority 1: Outstanding fees on purchase orders that
                    have aged out of eligibility

                -   Priority 2: Outstanding fees on the batch

                -   Priority 3: Outstanding principal on purchase orders
                    that have aged out of eligibility

                -   Priority 4: Outstanding fees on any batch

                -   Cascade: if nothing matches Priorities 0-4,
                    remaining fee-earmarked money cascades into the
                    Principal Priorities (starting at Principal Priority
                    1).

        -   principal repayment portion — maintains the intended
            relationship between outstanding principal and underlying
            collateral.

            -   Payments earmarked for principal repayment should be
                paid down in this order

                -   Priority 1: Outstanding principal on purchase orders
                    that have aged out of eligibility

                -   Priority 2: Outstanding principal in this batch

                -   Priority 3: Principal from oldest invoices in the
                    same batch as the payment was applied to

                -   Priority 4: Principal from oldest invoices
                    outstanding in any batch

                -   Priority 5: Fees from oldest invoices outstanding in
                    any batch

                -   Priority 6: If the balance of all principal and fees
                    is 0, the remaining funds will be remitted to the
                    Client

Note: the original numbering in this section skipped Priority 3 (typo).
The renumbering above makes priorities consecutive and leaves execution
order unchanged.

# Purchase Order Cancellations

Purchase orders can be cancelled. The cancellation signal can come from
either (a) a retailer CSV upload where the PO appears with a
"cancelled" status, or (b) the Manager manually using the "Cancel a
Purchase Order" action. In Phase 1 the Manager-initiated path is the
primary workflow; the CSV-signaled path is supported end-to-end by the
retailer parsers so that when retailer feeds automate, no additional
work is required.

When a PO is cancelled, the workflow depends on whether it carries an
outstanding balance:

-   If the cancelled PO has NO outstanding principal or fees: the PO is
    marked cancelled, removed from active borrowing base calculations,
    and no further action is required. Fees on any previously-settled
    advances are unaffected.

-   If the cancelled PO HAS outstanding principal or fees: the PO is
    marked cancelled AND moved into Advances in Bad Standing with
    bad-standing reason = "cancelled." The PO retains its outstanding
    principal and continues to accrue fees at the subsequent-period rate
    (the fee clock is not affected by cancellation). The Manager
    remediates through the standard Advances in Bad Standing remedies
    (primarily: transfer the balance — principal + accrued fees — to
    another active PO or invoice in the same batch with eligible
    borrowing base available). The original cancelled PO is marked
    transferred_out with balance $0 once remediation completes,
    retaining a link to the receiving advance for full audit
    traceability.

Cancellation rules:

-   If a PO was partially invoiced before cancellation, the cancellation
    applies only to the still-PO (uninvoiced) remainder. The
    already-invoiced (AR) portion continues in the normal AR lifecycle.
    Principal allocation between the still-PO and AR portions follows
    the pro-rata rule described in Invoice Upload Methodology; any
    balance sitting on the still-PO portion at cancellation time is what
    enters bad standing.

-   Cancellation requires a reason: free-text memo (required) plus an
    optional category (shortage, quality, retailer cancelled, client
    request, other).

-   Cancellation is logged as an event in the ledger. Uncancelling
    (reopening) a PO is supported as an undo operation with the standard
    cascade-preview rules.

-   Cancelled POs are excluded from the advance-selection UI by default.
    A filter toggle can include them (visible only for reference ---
    they cannot receive new advances).

-   Cancellation notifications: when a PO with outstanding principal is
    cancelled, an email is sent to overadvanced@seakingcapital.com
    (reusing the existing Over Advanced alert infrastructure)
    summarizing the outstanding balance that now requires remediation
    and linking to the affected PO in the Advances in Bad Standing menu.
    This is independent of whether the Client is in a Client-level Over
    Advanced state.

# Advances in Bad Standing

(This section expands on the "Advances in Bad Standing" button
referenced in the Main Interface.)

Advances in Bad Standing covers three conditions:

-   Aged-Out: the underlying invoice has crossed the day threshold set
    in Borrowing Base Rules and no longer contributes to the borrowing
    base, though the advance still counts toward reducing borrowing
    availability. Fees continue to accrue at the subsequent-period rate.

-   Over Advanced at the purchase-order level: an advance exceeding 100%
    of its underlying value (e.g., after an invoice came in at a lower
    value than the PO, or after a PO was split). This is distinct from
    the Client-level Over Advanced state.

-   Cancelled-with-outstanding-principal: the PO has been cancelled (by
    CSV signal or Manager action) and carries outstanding advanced
    principal that must be remediated. Fees continue to accrue at the
    subsequent-period rate until the balance is transferred or otherwise
    cured.

The Advances in Bad Standing menu shows a table of all advances in bad
standing with columns: advance ID, PO number, invoice number, retailer,
batch, original Advance Date, days aged out (if applicable), outstanding
principal, outstanding fees, underlying value, bad-standing reason
(aged-out / over-advanced / cancelled), and cancellation memo (if
applicable).

Manager remedies:

-   Add a note to the advance

-   Flag for collection

-   Transfer balance (principal + accrued fees) to a different
    receivable in the same batch with eligible borrowing base
    availability. The transferred balance retains its original Advance
    Date so fees on it continue to accrue using the correct date (this
    is why a PO outstanding 60 days may carry 120 days of fees — the
    fees were legitimately accrued on the original, now-transferred
    advance). The original bad-standing advance is marked
    transferred_out with balance $0 and remains visible in the ledger
    with a link to the receiving advance. The receiving advance carries
    a transferred_in_from link back to the original advance. Both
    records are visible in audit.

-   Mark as written off (Admin Manager only). Written-off advances are
    excluded from active calculations and borrowing base but retain full
    audit trail.

-   Generate a Client notice (printable report) summarizing the
    bad-standing position.

# Record a Remittance

Balances that work their way through the payment logic and result in a
remittance contribute to the balance shown in this tool. From here, the
Manager can indicate that we have sent a wire and record:

-   Wire amount

-   Wire date

-   Wire tracking number

-   The Wire date is Manager-entered and editable (in case a wire
    doesn't go out until the next business day, the Manager can correct
    the date).

When a wire is recording in this section, the Remittance balance is
reduced by the number shown

Remittance IDs should be generated in the database

Remittance dates are not auto-reconciled against bank statements in
Phase 1 — Manager entry is the source of truth for remittance dates.

# A Note on the Data

As purchase orders move through the lifecycle (PO advance → AR advance →
payment → remittance), the purchase order number is the common thread
that ties the stages together. The unique identity of a PO in the
database is the three-part key client_id + retailer_id + po_number. This
prevents collisions when (a) the same retailer reissues a PO number
years later, or (b) two Clients both sell to the same retailer with
overlapping PO numbers. The human-readable display label (e.g.,
"Walmart-PO12345") is derived from retailer name + po_number for UI
purposes only — it is never the database key.

All Dollar related values should be formatted as "$#,##0.00", and
values should be rounded to the nearest cent always.

Money storage standard (confirmed during Q&A): all monetary amounts are
stored as integer cents (bigint) throughout the database and application
logic. Conversion to display format happens only at the API/UI boundary.
All calendar dates are stored as date type (not timestamptz) anchored to
America/New_York. Event timestamps use timestamptz for ordering only.
All USD for Phase 1; multi-currency support is explicitly out of scope.

Three categories of dates tracked throughout the system:

-   effective_date — the business date an event applies to. For
    advances: the Advance Date (drives fee accrual start). For payments:
    the bank posting date (stops the fee clock on principal paid down).
    For remittances: the Manager-entered wire date (used for timeliness
    reporting to Client). Editable by the Manager at creation time.

-   recorded_at — the timestamp (timestamptz) at which the Manager
    committed the event in the app. System-set; not editable.

-   created_at — identical to recorded_at in practice, retained as a
    separate column for event-sourcing conventions (audit ordering).

# Definitions of Key Metrics

-   Purchase Order Advancing

    -   Extending an advance on purchase orders that are yet to be
        delivered and invoiced

    -   Upon invoicing, these convert to Accounts Receivable Advances

-   Accounts Receivable Advancing

    -   Extending an advance on purchase orders that have been invoiced
        and therefore are accounts receivable

    -   Purchase order advances that an invoice is submitted on
        automatically become Accounts Receivable Advances

-   Borrowing Ratio

    -   If the purchase order is not yet invoiced, it is: principal
        advanced / total purchase order value

    -   If the purchase order has been invoiced, it is: principal
        advanced / total invoice value

-   PO Principal Outstanding

    -   The total outstanding advances on purchase orders that have not
        yet been invoiced

    -   Does not include fees

-   PO Borrowing Base

    -   A percentage of outstanding purchase order value.

    -   This is set by the Manager in the Borrowing Base menu.

-   PO Borrowing Base Available

    -   PO Borrowing Base minus the principal outstanding on
        non-invoiced purchase orders

-   AR Principal Outstanding

    -   The total outstanding advances on unpaid invoices

    -   Does not include fees

-   AR Borrowing Base

    -   A percentage of outstanding invoice value.

    -   This is set by the Manager in the Borrowing Base menu.

    -   Receivables that are over the day threshold set by the Manager
        in the Borrowing Base menu will not contribute to the AR
        Borrowing Base

-   AR Borrowing Base Available

    -   AR Borrowing Base minus principal outstanding on invoiced
        purchase orders

-   Pre-Advance Accounts Receivable Principal Outstanding

    -   The total outstanding pre-advances

    -   Does not include fees

-   Pre-Advance Accounts Receivable Borrowing Base

    -   A percentage of AR Principal Outstanding, set by the Manager in
        the Borrowing Base menu

-   Pre-Advance Accounts Receivable Borrowing Base Available

    -   Pre-Advance Accounts Receivable Borrowing Base minus Pre-Advance
        Accounts Receivable Principal Outstanding

-   Advance Series

    -   A distinct series of advanced capital on a single PO/invoice,
        identified by its own Advance Date. A single PO/invoice can
        carry multiple advance series if additional capital was extended
        on different dates, each with its own fee schedule.

-   Aged-Out

    -   An invoice that has crossed the day threshold set in Borrowing
        Base Rules. The invoice no longer contributes to the borrowing
        base, though any advance on it still counts against borrowing
        availability. Fees continue to accrue.

-   Over Advanced (Client-Level)

    -   A Client-level state in which total principal outstanding
        exceeds total borrowing base available. Triggers a block on new
        advances, an email to overadvanced@seakingcapital.com, and a
        portal alert. Automatically clears when principal returns to ≤
        borrowing base.

-   Over Advanced (PO-Level / Bad Standing)

    -   An individual advance exceeding 100% of its underlying
        PO/invoice value. Flagged in the Advances in Bad Standing menu;
        remediation options available.

-   Cancelled Purchase Order

    -   A PO whose underlying order has been cancelled by the retailer
        or the Manager. Cancellation can be signaled via retailer CSV
        (status = cancelled) or initiated by the Manager through the
        "Cancel a Purchase Order" action. Cancelled POs with
        outstanding advanced principal enter Advances in Bad Standing
        with bad-standing reason = "cancelled" and require
        remediation.

-   One-Time Fee

    -   A fee assessed by the Manager on an ad-hoc basis, attached to a
        specific advance, PO, invoice, batch, or the Client broadly.
        Enters the same fee bucket as periodic fees. Client-level
        one-time fees get Fee Priority 0 (highest); others are collected
        alongside their target's existing priority.

-   Transferred Balance

    -   Principal and accrued fees moved from a bad-standing advance to
        a receivable in good standing in the same batch. Retains its
        original Advance Date so fees accrue correctly; full audit trail
        preserved on both source and destination advances.

-   Advance Request

    -   A Client-initiated request for an advance, submitted via the
        Client portal. Reviewed by a Manager and either approved
        (resulting in one or more actual advances linked back to the
        request) or rejected. Statuses: pending, approved, rejected,
        fulfilled.

-   Payment Allocation (% to Principal / % to Fees)

    -   Two independent inputs in the Borrowing Base Rules menu that
        determine how each incoming payment is split between principal
        priorities and fee priorities in the waterfall. The two values
        must sum to 100%. They default to the AR advance rate but can be
        edited independently. The Principal Only override (see Record a
        Payment, Step 3) bypasses this split for a specific payment.

# Reports & Exports (Phase 1)

All reports available in CSV format with a printable report view (HTML,
optimized for print-to-PDF):

-   Borrowing Base Certificate — snapshot of borrowing base, principal
    outstanding, and availability as of a user-selected date, per
    Client.

-   Aging Report — outstanding POs and invoices bucketed by age
    (current, 1-30, 31-60, 61-90, 90+), per Client.

-   Fee Accrual Report — all fees charged in a user-selected date
    range, per Client, with breakdown by periodic vs. one-time and by
    advance.

-   Payment History — all payments received in a user-selected date
    range, per Client, with match status and allocation breakdown.

-   Full Ledger Export — all events (advances, payments, remittances,
    fee accruals, fee collections, conversions, undos) for a Client,
    filterable by event type and date range. Used for external audit.

-   Year-End Fee Summary — total net fees earned per Client for the
    calendar year, for tax reporting reference (not a 1099 form itself
    — Phase 1 produces the data, form generation is out of scope).

-   Deductions Report — deductions by category by retailer over a
    user-selected date range, per Client.

-   Cancellations Report — all cancelled POs in a user-selected date
    range, per Client, with cancellation reason, category, and
    remediation outcome (transferred, written off, etc.).

# Notifications (Phase 1)

All transactional emails are sent via Resend. Email templates live in
packages/notifications/templates/.

-   Advance Committed → sent to Client (notifies them that an advance
    has been recorded)

-   Remittance Issued → sent to Client (notifies them that a wire has
    been sent)

-   Over Advanced Alert → sent to overadvanced@seakingcapital.com
    (Manager only; includes summary and link to Over Advanced page; uses
    term "Over Advanced")

-   Over Advanced Cleared → sent to Manager only when Client returns to
    ≤ 100% of borrowing base

-   Aged-Out Warning → sent 5 days before any invoice would age out
    (toggleable off, lead time adjustable). All advances with the same
    Advance Date are grouped into a single email to prevent spam. Sent
    to Manager only.

-   Weekly Digest → sent to Manager every Monday morning
    America/New_York; summary of the prior week's activity per Client
    (advances made, payments received, remittances issued, fees accrued,
    current borrowing position).

-   Advance Request Submitted → sent to
    advancerequest@seakingcapital.com with summary, attachments, and a
    link to the request.

-   PO Cancelled With Outstanding Principal → sent to
    overadvanced@seakingcapital.com when a cancelled PO enters Advances
    in Bad Standing. Includes PO details, outstanding balance, and a
    link to the Advances in Bad Standing menu.

# User Roles & Permissions (Phase 1)

Phase 1 implements four role categories. Investor and Creditor are
stubbed (tables exist, no UI).

-   Admin Manager — full permissions: set Borrowing Base rules, set
    Fee rules, invite new users, assign roles, set per-Client access
    permissions, undo any change, write off advances.

-   Operator — record advances, payments, remittances, upload data,
    approve/reject advance requests, run exports. Cannot change rules,
    invite users, or execute write-offs.

-   Client — read-only access to their own data at invoice level. Can
    see fee rules that apply to them, their batch names and amounts,
    their remittance history, and their current balance (current
    principal and current fees owed). Can submit advance requests with
    invoice attachments and free-text context.

-   Investor (stub) — read-only access to summary data for specific
    Clients they are permissioned for. Return metrics (net fees earned,
    total volume). No UI in Phase 1.

-   Creditor (stub) — read-only access to summary data for specific
    Clients they are permissioned for. Coverage metrics (collateral vs.
    funds advanced). No UI in Phase 1.

# Attached Files and Descriptions

-   ExampleChaseBankStatement

    -   This is a bank statement export from Chase, which is referenced
        in the 'Record a Payment' section of the prompt

        -   Column A contains the transaction type (CREDIT / DEBIT) ---
            useful for filtering out outgoing wires and internal
            transfers during ingestion.

        -   Column B contains the posting date

        -   Column C contains the description

            -   This is where retailer should be derived

            -   Correct me if you disagree, but I assume the simplest
                way to start is to have a unique lookup for each
                retailer we support.

                -   In this example, all payments made by Walmart
                    contain 'Walmart Inc.', so that would serve as the
                    lookup ID for Walmart

        -   Column D contains the payment amount (negative for DEBIT).

        -   Column E contains the bank-classified transaction type
            (ACH_CREDIT, WIRE_INCOMING, WIRE_OUTGOING, ACCT_XFER).

        -   Internal transfers ("Online Transfer to CHK...") are
            ignored by default during ingestion.

        -   Outgoing wires with "REMITTANCE" in memo are flagged for
            Manager review but do not auto-reconcile to the remittance
            ledger (Manager-entered remittance dates are source of truth
            in Phase 1).

-   Walmart and Kroger retailer files — to be provided separately:

    -   Walmart Purchase Order export (CSV)

    -   Walmart Invoice export (CSV)

    -   Walmart Payment export (CSV)

    -   Kroger Purchase Order export (CSV)

    -   Kroger Invoice export (CSV)

    -   Kroger Payment export (CSV)

    -   Generic CSV templates (for retailers without standardized
        exports)
