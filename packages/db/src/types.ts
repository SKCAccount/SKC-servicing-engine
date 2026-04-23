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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      advance_request_attachments: {
        Row: {
          advance_request_id: string
          filename: string
          id: string
          mime_type: string
          size_bytes: number
          storage_path: string
          uploaded_at: string
        }
        Insert: {
          advance_request_id: string
          filename: string
          id?: string
          mime_type: string
          size_bytes: number
          storage_path: string
          uploaded_at?: string
        }
        Update: {
          advance_request_id?: string
          filename?: string
          id?: string
          mime_type?: string
          size_bytes?: number
          storage_path?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "advance_request_attachments_advance_request_id_fkey"
            columns: ["advance_request_id"]
            isOneToOne: false
            referencedRelation: "advance_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      advance_requests: {
        Row: {
          client_id: string
          context_text: string | null
          created_at: string
          id: string
          rejection_reason: string | null
          requested_amount_cents: number
          requested_by: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["advance_request_status"]
          updated_at: string
          version: number
        }
        Insert: {
          client_id: string
          context_text?: string | null
          created_at?: string
          id?: string
          rejection_reason?: string | null
          requested_amount_cents: number
          requested_by: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["advance_request_status"]
          updated_at?: string
          version?: number
        }
        Update: {
          client_id?: string
          context_text?: string | null
          created_at?: string
          id?: string
          rejection_reason?: string | null
          requested_amount_cents?: number
          requested_by?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["advance_request_status"]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "advance_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advance_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "advance_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advance_requests_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      advances: {
        Row: {
          advance_date: string
          advance_request_id: string | null
          advance_type: Database["public"]["Enums"]["advance_type"]
          batch_id: string
          capital_source_creditor_id: string | null
          capital_source_investor_id: string | null
          client_id: string
          committed_at: string
          committed_by: string
          created_at: string
          funded_at: string | null
          funded_by_bank_transaction_id: string | null
          funded_wire_number: string | null
          id: string
          initial_principal_cents: number
          invoice_id: string | null
          purchase_order_id: string | null
          rule_set_id: string
          status: Database["public"]["Enums"]["advance_status"]
          transferred_from_advance_id: string | null
          transferred_to_advance_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          advance_date: string
          advance_request_id?: string | null
          advance_type: Database["public"]["Enums"]["advance_type"]
          batch_id: string
          capital_source_creditor_id?: string | null
          capital_source_investor_id?: string | null
          client_id: string
          committed_at?: string
          committed_by: string
          created_at?: string
          funded_at?: string | null
          funded_by_bank_transaction_id?: string | null
          funded_wire_number?: string | null
          id?: string
          initial_principal_cents: number
          invoice_id?: string | null
          purchase_order_id?: string | null
          rule_set_id: string
          status?: Database["public"]["Enums"]["advance_status"]
          transferred_from_advance_id?: string | null
          transferred_to_advance_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          advance_date?: string
          advance_request_id?: string | null
          advance_type?: Database["public"]["Enums"]["advance_type"]
          batch_id?: string
          capital_source_creditor_id?: string | null
          capital_source_investor_id?: string | null
          client_id?: string
          committed_at?: string
          committed_by?: string
          created_at?: string
          funded_at?: string | null
          funded_by_bank_transaction_id?: string | null
          funded_wire_number?: string | null
          id?: string
          initial_principal_cents?: number
          invoice_id?: string | null
          purchase_order_id?: string | null
          rule_set_id?: string
          status?: Database["public"]["Enums"]["advance_status"]
          transferred_from_advance_id?: string | null
          transferred_to_advance_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "advances_advance_request_id_fkey"
            columns: ["advance_request_id"]
            isOneToOne: false
            referencedRelation: "advance_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mv_batch_position"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "advances_capital_source_creditor_id_fkey"
            columns: ["capital_source_creditor_id"]
            isOneToOne: false
            referencedRelation: "creditors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_capital_source_investor_id_fkey"
            columns: ["capital_source_investor_id"]
            isOneToOne: false
            referencedRelation: "investors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "advances_committed_by_fkey"
            columns: ["committed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_funded_by_bank_transaction_fk"
            columns: ["funded_by_bank_transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "mv_invoice_aging"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "advances_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_rule_set_id_fkey"
            columns: ["rule_set_id"]
            isOneToOne: false
            referencedRelation: "rule_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_transferred_from_advance_id_fkey"
            columns: ["transferred_from_advance_id"]
            isOneToOne: false
            referencedRelation: "advances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_transferred_from_advance_id_fkey"
            columns: ["transferred_from_advance_id"]
            isOneToOne: false
            referencedRelation: "mv_advance_balances"
            referencedColumns: ["advance_id"]
          },
          {
            foreignKeyName: "advances_transferred_from_advance_id_fkey"
            columns: ["transferred_from_advance_id"]
            isOneToOne: false
            referencedRelation: "v_client_advances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_transferred_to_advance_id_fkey"
            columns: ["transferred_to_advance_id"]
            isOneToOne: false
            referencedRelation: "advances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_transferred_to_advance_id_fkey"
            columns: ["transferred_to_advance_id"]
            isOneToOne: false
            referencedRelation: "mv_advance_balances"
            referencedColumns: ["advance_id"]
          },
          {
            foreignKeyName: "advances_transferred_to_advance_id_fkey"
            columns: ["transferred_to_advance_id"]
            isOneToOne: false
            referencedRelation: "v_client_advances"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          after: Json | null
          before: Json | null
          changed_at: string
          changed_by: string | null
          client_id: string | null
          id: string
          operation: string
          row_id: string
          table_name: string
        }
        Insert: {
          after?: Json | null
          before?: Json | null
          changed_at?: string
          changed_by?: string | null
          client_id?: string | null
          id?: string
          operation: string
          row_id: string
          table_name: string
        }
        Update: {
          after?: Json | null
          before?: Json | null
          changed_at?: string
          changed_by?: string | null
          client_id?: string | null
          id?: string
          operation?: string
          row_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_transactions: {
        Row: {
          amount_cents: number
          bank_classified_type: string
          bank_upload_id: string
          client_id: string
          created_at: string
          description: string
          direction: Database["public"]["Enums"]["bank_direction"]
          id: string
          memo_classification:
            | Database["public"]["Enums"]["bank_memo_class"]
            | null
          notes: string | null
          posting_date: string
          principal_only_override: boolean
          retailer_id: string | null
          status: Database["public"]["Enums"]["bank_txn_status"]
          updated_at: string
          version: number
        }
        Insert: {
          amount_cents: number
          bank_classified_type: string
          bank_upload_id: string
          client_id: string
          created_at?: string
          description: string
          direction: Database["public"]["Enums"]["bank_direction"]
          id?: string
          memo_classification?:
            | Database["public"]["Enums"]["bank_memo_class"]
            | null
          notes?: string | null
          posting_date: string
          principal_only_override?: boolean
          retailer_id?: string | null
          status?: Database["public"]["Enums"]["bank_txn_status"]
          updated_at?: string
          version?: number
        }
        Update: {
          amount_cents?: number
          bank_classified_type?: string
          bank_upload_id?: string
          client_id?: string
          created_at?: string
          description?: string
          direction?: Database["public"]["Enums"]["bank_direction"]
          id?: string
          memo_classification?:
            | Database["public"]["Enums"]["bank_memo_class"]
            | null
          notes?: string | null
          posting_date?: string
          principal_only_override?: boolean
          retailer_id?: string | null
          status?: Database["public"]["Enums"]["bank_txn_status"]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_bank_upload_id_fkey"
            columns: ["bank_upload_id"]
            isOneToOne: false
            referencedRelation: "bank_uploads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "bank_transactions_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_uploads: {
        Row: {
          client_id: string
          id: string
          notes: string | null
          parser_version: string
          row_count: number
          source_filename: string
          statement_end: string | null
          statement_start: string | null
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          client_id: string
          id?: string
          notes?: string | null
          parser_version: string
          row_count?: number
          source_filename: string
          statement_end?: string | null
          statement_start?: string | null
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          client_id?: string
          id?: string
          notes?: string | null
          parser_version?: string
          row_count?: number
          source_filename?: string
          statement_end?: string | null
          statement_start?: string | null
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "bank_uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      batches: {
        Row: {
          batch_number: number
          client_id: string
          created_at: string
          id: string
          name: string | null
          updated_at: string
          version: number
        }
        Insert: {
          batch_number: number
          client_id: string
          created_at?: string
          id?: string
          name?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          batch_number?: number
          client_id?: string
          created_at?: string
          id?: string
          name?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "batches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
        ]
      }
      client_deductions: {
        Row: {
          amount_cents: number
          client_id: string
          created_at: string
          dispute_memo: string | null
          disputed_at: string | null
          disputed_by: string | null
          division: string | null
          id: string
          known_on_date: string
          location_description: string | null
          memo: string | null
          netted_in_payment_ref: string | null
          resolution_memo: string | null
          resolved_at: string | null
          resolved_by: string | null
          resolved_by_bank_upload_id: string | null
          retailer_id: string
          reversed_by_bank_txn_id: string | null
          source_category: Database["public"]["Enums"]["client_deduction_source"]
          source_invoice_date: string | null
          source_ref: string
          source_subcategory: string | null
          status: Database["public"]["Enums"]["client_deduction_status"]
          updated_at: string
          upload_id: string | null
          version: number
        }
        Insert: {
          amount_cents: number
          client_id: string
          created_at?: string
          dispute_memo?: string | null
          disputed_at?: string | null
          disputed_by?: string | null
          division?: string | null
          id?: string
          known_on_date: string
          location_description?: string | null
          memo?: string | null
          netted_in_payment_ref?: string | null
          resolution_memo?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_by_bank_upload_id?: string | null
          retailer_id: string
          reversed_by_bank_txn_id?: string | null
          source_category: Database["public"]["Enums"]["client_deduction_source"]
          source_invoice_date?: string | null
          source_ref: string
          source_subcategory?: string | null
          status?: Database["public"]["Enums"]["client_deduction_status"]
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Update: {
          amount_cents?: number
          client_id?: string
          created_at?: string
          dispute_memo?: string | null
          disputed_at?: string | null
          disputed_by?: string | null
          division?: string | null
          id?: string
          known_on_date?: string
          location_description?: string | null
          memo?: string | null
          netted_in_payment_ref?: string | null
          resolution_memo?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          resolved_by_bank_upload_id?: string | null
          retailer_id?: string
          reversed_by_bank_txn_id?: string | null
          source_category?: Database["public"]["Enums"]["client_deduction_source"]
          source_invoice_date?: string | null
          source_ref?: string
          source_subcategory?: string | null
          status?: Database["public"]["Enums"]["client_deduction_status"]
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "client_deductions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_deductions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "client_deductions_disputed_by_fkey"
            columns: ["disputed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_deductions_resolved_by_bank_upload_id_fkey"
            columns: ["resolved_by_bank_upload_id"]
            isOneToOne: false
            referencedRelation: "bank_uploads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_deductions_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_deductions_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_deductions_reversed_by_bank_txn_id_fkey"
            columns: ["reversed_by_bank_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_deductions_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "invoice_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          created_at: string
          display_name: string
          id: string
          legal_name: string
          over_advanced_since: string | null
          over_advanced_state: boolean
          status: Database["public"]["Enums"]["client_status"]
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          display_name: string
          id?: string
          legal_name: string
          over_advanced_since?: string | null
          over_advanced_state?: boolean
          status?: Database["public"]["Enums"]["client_status"]
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          legal_name?: string
          over_advanced_since?: string | null
          over_advanced_state?: boolean
          status?: Database["public"]["Enums"]["client_status"]
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      creditor_client_access: {
        Row: {
          client_id: string
          creditor_id: string
          granted_at: string
          granted_by: string
        }
        Insert: {
          client_id: string
          creditor_id: string
          granted_at?: string
          granted_by: string
        }
        Update: {
          client_id?: string
          creditor_id?: string
          granted_at?: string
          granted_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "creditor_client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creditor_client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "creditor_client_access_creditor_id_fkey"
            columns: ["creditor_id"]
            isOneToOne: false
            referencedRelation: "creditors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creditor_client_access_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      creditors: {
        Row: {
          contact_email: string | null
          created_at: string
          id: string
          name: string
          updated_at: string
          version: number
        }
        Insert: {
          contact_email?: string | null
          created_at?: string
          id?: string
          name: string
          updated_at?: string
          version?: number
        }
        Update: {
          contact_email?: string | null
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      investor_client_access: {
        Row: {
          client_id: string
          granted_at: string
          granted_by: string
          investor_id: string
        }
        Insert: {
          client_id: string
          granted_at?: string
          granted_by: string
          investor_id: string
        }
        Update: {
          client_id?: string
          granted_at?: string
          granted_by?: string
          investor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "investor_client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "investor_client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "investor_client_access_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "investor_client_access_investor_id_fkey"
            columns: ["investor_id"]
            isOneToOne: false
            referencedRelation: "investors"
            referencedColumns: ["id"]
          },
        ]
      }
      investors: {
        Row: {
          contact_email: string | null
          created_at: string
          id: string
          name: string
          updated_at: string
          version: number
        }
        Insert: {
          contact_email?: string | null
          created_at?: string
          id?: string
          name: string
          updated_at?: string
          version?: number
        }
        Update: {
          contact_email?: string | null
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      invoice_deductions: {
        Row: {
          amount_cents: number
          category: Database["public"]["Enums"]["deduction_category"]
          created_at: string
          id: string
          invoice_id: string
          known_on_date: string
          memo: string | null
          payment_id: string | null
          updated_at: string
          version: number
        }
        Insert: {
          amount_cents: number
          category: Database["public"]["Enums"]["deduction_category"]
          created_at?: string
          id?: string
          invoice_id: string
          known_on_date: string
          memo?: string | null
          payment_id?: string | null
          updated_at?: string
          version?: number
        }
        Update: {
          amount_cents?: number
          category?: Database["public"]["Enums"]["deduction_category"]
          created_at?: string
          id?: string
          invoice_id?: string
          known_on_date?: string
          memo?: string | null
          payment_id?: string | null
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_deductions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_deductions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "mv_invoice_aging"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "invoice_deductions_payment_fk"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_uploads: {
        Row: {
          client_id: string
          id: string
          notes: string | null
          parser_version: string
          retailer_id: string | null
          row_count: number
          source_filename: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          client_id: string
          id?: string
          notes?: string | null
          parser_version: string
          retailer_id?: string | null
          row_count?: number
          source_filename: string
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          client_id?: string
          id?: string
          notes?: string | null
          parser_version?: string
          retailer_id?: string | null
          row_count?: number
          source_filename?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "invoice_uploads_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          approval_status: string | null
          created_at: string
          due_date: string | null
          goods_delivery_date: string | null
          goods_delivery_location: string | null
          id: string
          invoice_date: string
          invoice_number: string
          invoice_value_cents: number
          item_description: string | null
          paid_in_full_date: string | null
          purchase_order_id: string
          updated_at: string
          upload_id: string | null
          version: number
        }
        Insert: {
          approval_status?: string | null
          created_at?: string
          due_date?: string | null
          goods_delivery_date?: string | null
          goods_delivery_location?: string | null
          id?: string
          invoice_date: string
          invoice_number: string
          invoice_value_cents: number
          item_description?: string | null
          paid_in_full_date?: string | null
          purchase_order_id: string
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Update: {
          approval_status?: string | null
          created_at?: string
          due_date?: string | null
          goods_delivery_date?: string | null
          goods_delivery_location?: string | null
          id?: string
          invoice_date?: string
          invoice_number?: string
          invoice_value_cents?: number
          item_description?: string | null
          paid_in_full_date?: string | null
          purchase_order_id?: string
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "invoice_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      ledger_events: {
        Row: {
          advance_id: string | null
          bank_transaction_id: string | null
          batch_id: string | null
          client_id: string
          created_at: string
          created_by: string
          effective_date: string
          event_seq: number
          event_type: Database["public"]["Enums"]["ledger_event_type"]
          fee_delta_cents: number
          id: string
          invoice_id: string | null
          metadata: Json
          notes: string | null
          one_time_fee_id: string | null
          principal_delta_cents: number
          purchase_order_id: string | null
          recorded_at: string
          remittance_delta_cents: number
          remittance_id: string | null
          reversed_by_event_id: string | null
          reverses_event_id: string | null
        }
        Insert: {
          advance_id?: string | null
          bank_transaction_id?: string | null
          batch_id?: string | null
          client_id: string
          created_at?: string
          created_by: string
          effective_date: string
          event_seq?: never
          event_type: Database["public"]["Enums"]["ledger_event_type"]
          fee_delta_cents?: number
          id?: string
          invoice_id?: string | null
          metadata?: Json
          notes?: string | null
          one_time_fee_id?: string | null
          principal_delta_cents?: number
          purchase_order_id?: string | null
          recorded_at?: string
          remittance_delta_cents?: number
          remittance_id?: string | null
          reversed_by_event_id?: string | null
          reverses_event_id?: string | null
        }
        Update: {
          advance_id?: string | null
          bank_transaction_id?: string | null
          batch_id?: string | null
          client_id?: string
          created_at?: string
          created_by?: string
          effective_date?: string
          event_seq?: never
          event_type?: Database["public"]["Enums"]["ledger_event_type"]
          fee_delta_cents?: number
          id?: string
          invoice_id?: string | null
          metadata?: Json
          notes?: string | null
          one_time_fee_id?: string | null
          principal_delta_cents?: number
          purchase_order_id?: string | null
          recorded_at?: string
          remittance_delta_cents?: number
          remittance_id?: string | null
          reversed_by_event_id?: string | null
          reverses_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ledger_events_advance_id_fkey"
            columns: ["advance_id"]
            isOneToOne: false
            referencedRelation: "advances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_advance_id_fkey"
            columns: ["advance_id"]
            isOneToOne: false
            referencedRelation: "mv_advance_balances"
            referencedColumns: ["advance_id"]
          },
          {
            foreignKeyName: "ledger_events_advance_id_fkey"
            columns: ["advance_id"]
            isOneToOne: false
            referencedRelation: "v_client_advances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_bank_transaction_id_fkey"
            columns: ["bank_transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mv_batch_position"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "ledger_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "ledger_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "mv_invoice_aging"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "ledger_events_one_time_fee_id_fkey"
            columns: ["one_time_fee_id"]
            isOneToOne: false
            referencedRelation: "one_time_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_remittance_id_fkey"
            columns: ["remittance_id"]
            isOneToOne: false
            referencedRelation: "remittances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_reversed_by_event_id_fkey"
            columns: ["reversed_by_event_id"]
            isOneToOne: false
            referencedRelation: "ledger_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledger_events_reverses_event_id_fkey"
            columns: ["reverses_event_id"]
            isOneToOne: false
            referencedRelation: "ledger_events"
            referencedColumns: ["id"]
          },
        ]
      }
      one_time_fees: {
        Row: {
          amount_cents: number
          assessed_by: string
          assessed_date: string
          client_id: string
          created_at: string
          description: string
          id: string
          target_id: string | null
          target_type: Database["public"]["Enums"]["fee_target_type"]
          updated_at: string
          version: number
        }
        Insert: {
          amount_cents: number
          assessed_by: string
          assessed_date: string
          client_id: string
          created_at?: string
          description: string
          id?: string
          target_id?: string | null
          target_type: Database["public"]["Enums"]["fee_target_type"]
          updated_at?: string
          version?: number
        }
        Update: {
          amount_cents?: number
          assessed_by?: string
          assessed_date?: string
          client_id?: string
          created_at?: string
          description?: string
          id?: string
          target_id?: string | null
          target_type?: Database["public"]["Enums"]["fee_target_type"]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "one_time_fees_assessed_by_fkey"
            columns: ["assessed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "one_time_fees_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "one_time_fees_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
        ]
      }
      payment_bank_links: {
        Row: {
          amount_cents: number
          bank_transaction_id: string
          created_at: string
          id: string
          target_id: string
          target_type: Database["public"]["Enums"]["payment_link_target"]
        }
        Insert: {
          amount_cents: number
          bank_transaction_id: string
          created_at?: string
          id?: string
          target_id: string
          target_type: Database["public"]["Enums"]["payment_link_target"]
        }
        Update: {
          amount_cents?: number
          bank_transaction_id?: string
          created_at?: string
          id?: string
          target_id?: string
          target_type?: Database["public"]["Enums"]["payment_link_target"]
        }
        Relationships: [
          {
            foreignKeyName: "payment_bank_links_bank_transaction_id_fkey"
            columns: ["bank_transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      po_uploads: {
        Row: {
          client_id: string
          id: string
          notes: string | null
          parser_version: string
          retailer_id: string | null
          row_count: number
          source_filename: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          client_id: string
          id?: string
          notes?: string | null
          parser_version: string
          retailer_id?: string | null
          row_count?: number
          source_filename: string
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          client_id?: string
          id?: string
          notes?: string | null
          parser_version?: string
          retailer_id?: string | null
          row_count?: number
          source_filename?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "po_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "po_uploads_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_order_lines: {
        Row: {
          created_at: string
          id: string
          item_description: string | null
          line_number: number
          line_value_cents: number | null
          purchase_order_id: string
          quantity_ordered: number | null
          retailer_item_number: string | null
          status: Database["public"]["Enums"]["po_line_status"]
          unit_cost_cents: number | null
          updated_at: string
          upload_id: string | null
          version: number
        }
        Insert: {
          created_at?: string
          id?: string
          item_description?: string | null
          line_number: number
          line_value_cents?: number | null
          purchase_order_id: string
          quantity_ordered?: number | null
          retailer_item_number?: string | null
          status?: Database["public"]["Enums"]["po_line_status"]
          unit_cost_cents?: number | null
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Update: {
          created_at?: string
          id?: string
          item_description?: string | null
          line_number?: number
          line_value_cents?: number | null
          purchase_order_id?: string
          quantity_ordered?: number | null
          retailer_item_number?: string | null
          status?: Database["public"]["Enums"]["po_line_status"]
          unit_cost_cents?: number | null
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_lines_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "po_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          batch_id: string | null
          cancellation_memo: string | null
          cancellation_reason_category:
            | Database["public"]["Enums"]["cancellation_reason"]
            | null
          cancelled_at: string | null
          cancelled_by: string | null
          client_id: string
          created_at: string
          delivery_location: string | null
          id: string
          issuance_date: string | null
          item_description: string | null
          parent_po_id: string | null
          po_number: string
          po_value_cents: number
          quantity_ordered: number | null
          requested_delivery_date: string | null
          retailer_id: string
          status: Database["public"]["Enums"]["po_status"]
          unit_value_cents: number | null
          updated_at: string
          upload_id: string | null
          version: number
        }
        Insert: {
          batch_id?: string | null
          cancellation_memo?: string | null
          cancellation_reason_category?:
            | Database["public"]["Enums"]["cancellation_reason"]
            | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id: string
          created_at?: string
          delivery_location?: string | null
          id?: string
          issuance_date?: string | null
          item_description?: string | null
          parent_po_id?: string | null
          po_number: string
          po_value_cents: number
          quantity_ordered?: number | null
          requested_delivery_date?: string | null
          retailer_id: string
          status?: Database["public"]["Enums"]["po_status"]
          unit_value_cents?: number | null
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Update: {
          batch_id?: string | null
          cancellation_memo?: string | null
          cancellation_reason_category?:
            | Database["public"]["Enums"]["cancellation_reason"]
            | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          client_id?: string
          created_at?: string
          delivery_location?: string | null
          id?: string
          issuance_date?: string | null
          item_description?: string | null
          parent_po_id?: string | null
          po_number?: string
          po_value_cents?: number
          quantity_ordered?: number | null
          requested_delivery_date?: string | null
          retailer_id?: string
          status?: Database["public"]["Enums"]["po_status"]
          unit_value_cents?: number | null
          updated_at?: string
          upload_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mv_batch_position"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "purchase_orders_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "purchase_orders_parent_po_id_fkey"
            columns: ["parent_po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "po_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      remittances: {
        Row: {
          client_id: string
          created_at: string
          created_by: string
          id: string
          notes: string | null
          updated_at: string
          version: number
          wire_amount_cents: number
          wire_date: string
          wire_tracking_number: string
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by: string
          id?: string
          notes?: string | null
          updated_at?: string
          version?: number
          wire_amount_cents: number
          wire_date: string
          wire_tracking_number: string
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string
          id?: string
          notes?: string | null
          updated_at?: string
          version?: number
          wire_amount_cents?: number
          wire_date?: string
          wire_tracking_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "remittances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "remittances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "remittances_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      retailer_payment_details: {
        Row: {
          created_at: string
          deduction_cents: number
          discount_cents: number
          id: string
          invoice_amount_cents: number
          invoice_date: string | null
          invoice_number: string
          match_type: Database["public"]["Enums"]["match_type"] | null
          matched_bank_transaction_id: string | null
          paid_amount_cents: number
          payment_date: string
          purchase_order_number: string
          resolved_invoice_id: string | null
          retailer_id: string
          retailer_payment_upload_id: string
          updated_at: string
          version: number
        }
        Insert: {
          created_at?: string
          deduction_cents?: number
          discount_cents?: number
          id?: string
          invoice_amount_cents: number
          invoice_date?: string | null
          invoice_number: string
          match_type?: Database["public"]["Enums"]["match_type"] | null
          matched_bank_transaction_id?: string | null
          paid_amount_cents: number
          payment_date: string
          purchase_order_number: string
          resolved_invoice_id?: string | null
          retailer_id: string
          retailer_payment_upload_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          created_at?: string
          deduction_cents?: number
          discount_cents?: number
          id?: string
          invoice_amount_cents?: number
          invoice_date?: string | null
          invoice_number?: string
          match_type?: Database["public"]["Enums"]["match_type"] | null
          matched_bank_transaction_id?: string | null
          paid_amount_cents?: number
          payment_date?: string
          purchase_order_number?: string
          resolved_invoice_id?: string | null
          retailer_id?: string
          retailer_payment_upload_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "retailer_payment_details_matched_bank_transaction_id_fkey"
            columns: ["matched_bank_transaction_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retailer_payment_details_resolved_invoice_id_fkey"
            columns: ["resolved_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retailer_payment_details_resolved_invoice_id_fkey"
            columns: ["resolved_invoice_id"]
            isOneToOne: false
            referencedRelation: "mv_invoice_aging"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "retailer_payment_details_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retailer_payment_details_retailer_payment_upload_id_fkey"
            columns: ["retailer_payment_upload_id"]
            isOneToOne: false
            referencedRelation: "retailer_payment_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      retailer_payment_uploads: {
        Row: {
          client_id: string
          id: string
          notes: string | null
          parser_version: string
          retailer_id: string
          row_count: number
          source_filename: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string
        }
        Insert: {
          client_id: string
          id?: string
          notes?: string | null
          parser_version: string
          retailer_id: string
          row_count?: number
          source_filename: string
          storage_path: string
          uploaded_at?: string
          uploaded_by: string
        }
        Update: {
          client_id?: string
          id?: string
          notes?: string | null
          parser_version?: string
          retailer_id?: string
          row_count?: number
          source_filename?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "retailer_payment_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retailer_payment_uploads_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "retailer_payment_uploads_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retailer_payment_uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      retailers: {
        Row: {
          bank_description_patterns: string[]
          created_at: string
          display_name: string
          has_standardized_parser: boolean
          id: string
          name: string
          updated_at: string
          version: number
        }
        Insert: {
          bank_description_patterns?: string[]
          created_at?: string
          display_name: string
          has_standardized_parser?: boolean
          id?: string
          name: string
          updated_at?: string
          version?: number
        }
        Update: {
          bank_description_patterns?: string[]
          created_at?: string
          display_name?: string
          has_standardized_parser?: boolean
          id?: string
          name?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      rule_sets: {
        Row: {
          aged_out_warning_lead_days: number
          aged_out_warnings_enabled: boolean
          ar_advance_rate_bps: number
          ar_aged_out_days: number
          client_id: string
          created_at: string
          created_by: string
          effective_from: string
          effective_to: string | null
          id: string
          payment_allocation_fee_bps: number
          payment_allocation_principal_bps: number
          period_1_days: number
          period_1_fee_rate_bps: number
          period_2_days: number
          period_2_fee_rate_bps: number
          po_advance_rate_bps: number
          pre_advance_rate_bps: number
          subsequent_period_days: number
          subsequent_period_fee_rate_bps: number
        }
        Insert: {
          aged_out_warning_lead_days?: number
          aged_out_warnings_enabled?: boolean
          ar_advance_rate_bps: number
          ar_aged_out_days: number
          client_id: string
          created_at?: string
          created_by: string
          effective_from: string
          effective_to?: string | null
          id?: string
          payment_allocation_fee_bps: number
          payment_allocation_principal_bps: number
          period_1_days: number
          period_1_fee_rate_bps: number
          period_2_days: number
          period_2_fee_rate_bps: number
          po_advance_rate_bps: number
          pre_advance_rate_bps: number
          subsequent_period_days: number
          subsequent_period_fee_rate_bps: number
        }
        Update: {
          aged_out_warning_lead_days?: number
          aged_out_warnings_enabled?: boolean
          ar_advance_rate_bps?: number
          ar_aged_out_days?: number
          client_id?: string
          created_at?: string
          created_by?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          payment_allocation_fee_bps?: number
          payment_allocation_principal_bps?: number
          period_1_days?: number
          period_1_fee_rate_bps?: number
          period_2_days?: number
          period_2_fee_rate_bps?: number
          po_advance_rate_bps?: number
          pre_advance_rate_bps?: number
          subsequent_period_days?: number
          subsequent_period_fee_rate_bps?: number
        }
        Relationships: [
          {
            foreignKeyName: "rule_sets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rule_sets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "rule_sets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      user_client_access: {
        Row: {
          client_id: string
          granted_at: string
          granted_by: string
          user_id: string
        }
        Insert: {
          client_id: string
          granted_at?: string
          granted_by: string
          user_id: string
        }
        Update: {
          client_id?: string
          granted_at?: string
          granted_by?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "user_client_access_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_client_access_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          client_id: string | null
          created_at: string
          email: string
          id: string
          notification_preferences: Json
          role: Database["public"]["Enums"]["user_role"]
          status: Database["public"]["Enums"]["user_status"]
          updated_at: string
          version: number
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          email: string
          id: string
          notification_preferences?: Json
          role: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["user_status"]
          updated_at?: string
          version?: number
        }
        Update: {
          client_id?: string | null
          created_at?: string
          email?: string
          id?: string
          notification_preferences?: Json
          role?: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["user_status"]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
        ]
      }
    }
    Views: {
      mv_advance_balances: {
        Row: {
          advance_date: string | null
          advance_id: string | null
          advance_type: Database["public"]["Enums"]["advance_type"] | null
          batch_id: string | null
          client_id: string | null
          fee_accrual_count: number | null
          fees_outstanding_cents: number | null
          initial_principal_cents: number | null
          invoice_id: string | null
          last_principal_payment_date: string | null
          principal_outstanding_cents: number | null
          purchase_order_id: string | null
          rule_set_id: string | null
          status: Database["public"]["Enums"]["advance_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "advances_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mv_batch_position"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "advances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "advances_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "mv_invoice_aging"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "advances_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_rule_set_id_fkey"
            columns: ["rule_set_id"]
            isOneToOne: false
            referencedRelation: "rule_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      mv_batch_position: {
        Row: {
          active_advance_count: number | null
          batch_id: string | null
          batch_number: number | null
          client_id: string | null
          fees_outstanding_cents: number | null
          name: string | null
          principal_outstanding_cents: number | null
        }
        Relationships: [
          {
            foreignKeyName: "batches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "batches_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
        ]
      }
      mv_client_position: {
        Row: {
          active_po_value_cents: number | null
          ar_borrowing_base_available_cents: number | null
          ar_borrowing_base_cents: number | null
          ar_principal_outstanding_cents: number | null
          client_id: string | null
          display_name: string | null
          eligible_ar_value_cents: number | null
          is_over_advanced: boolean | null
          po_borrowing_base_available_cents: number | null
          po_borrowing_base_cents: number | null
          po_principal_outstanding_cents: number | null
          pre_advance_borrowing_base_available_cents: number | null
          pre_advance_borrowing_base_cents: number | null
          pre_advance_principal_outstanding_cents: number | null
          remittance_balance_cents: number | null
          total_fees_outstanding_cents: number | null
          total_principal_outstanding_cents: number | null
        }
        Relationships: []
      }
      mv_invoice_aging: {
        Row: {
          age_bucket: string | null
          client_id: string | null
          days_outstanding: number | null
          deduction_cents_total: number | null
          due_date: string | null
          effective_invoice_value_cents: number | null
          invoice_date: string | null
          invoice_id: string | null
          invoice_number: string | null
          invoice_value_cents: number | null
          is_aged_out: boolean | null
          paid_in_full_date: string | null
          purchase_order_id: string | null
          retailer_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "purchase_orders_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
        ]
      }
      v_all_deductions: {
        Row: {
          amount_cents: number | null
          category_invoice: string | null
          client_id: string | null
          created_at: string | null
          deduction_level: string | null
          id: string | null
          known_on_date: string | null
          memo: string | null
          retailer_id: string | null
          source_category_client: string | null
          status: string | null
        }
        Relationships: []
      }
      v_client_advances: {
        Row: {
          advance_date: string | null
          advance_type: Database["public"]["Enums"]["advance_type"] | null
          batch_id: string | null
          client_id: string | null
          fees_outstanding_cents: number | null
          id: string | null
          initial_principal_cents: number | null
          invoice_id: string | null
          principal_outstanding_cents: number | null
          purchase_order_id: string | null
          status: Database["public"]["Enums"]["advance_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "advances_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "mv_batch_position"
            referencedColumns: ["batch_id"]
          },
          {
            foreignKeyName: "advances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "mv_client_position"
            referencedColumns: ["client_id"]
          },
          {
            foreignKeyName: "advances_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "advances_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "mv_invoice_aging"
            referencedColumns: ["invoice_id"]
          },
          {
            foreignKeyName: "advances_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      current_rule_set: {
        Args: { p_client_id: string }
        Returns: {
          aged_out_warning_lead_days: number
          aged_out_warnings_enabled: boolean
          ar_advance_rate_bps: number
          ar_aged_out_days: number
          client_id: string
          created_at: string
          created_by: string
          effective_from: string
          effective_to: string | null
          id: string
          payment_allocation_fee_bps: number
          payment_allocation_principal_bps: number
          period_1_days: number
          period_1_fee_rate_bps: number
          period_2_days: number
          period_2_fee_rate_bps: number
          po_advance_rate_bps: number
          pre_advance_rate_bps: number
          subsequent_period_days: number
          subsequent_period_fee_rate_bps: number
        }
        SetofOptions: {
          from: "*"
          to: "rule_sets"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_user_client_ids: { Args: never; Returns: string[] }
      current_user_role: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      is_admin_manager: { Args: never; Returns: boolean }
      is_client_user: { Args: never; Returns: boolean }
      is_manager: { Args: never; Returns: boolean }
      next_batch_number: { Args: { p_client_id: string }; Returns: number }
      po_display_label: {
        Args: {
          p_po: Database["public"]["Tables"]["purchase_orders"]["Row"]
          p_retailer: Database["public"]["Tables"]["retailers"]["Row"]
        }
        Returns: string
      }
      po_line_value_variance: { Args: { p_po_id: string }; Returns: number }
      recompute_client_over_advanced: {
        Args: { p_client_id: string }
        Returns: undefined
      }
    }
    Enums: {
      advance_request_status: "pending" | "approved" | "rejected" | "fulfilled"
      advance_status:
        | "committed"
        | "funded"
        | "paid_in_full"
        | "transferred_out"
        | "written_off"
        | "reversed"
      advance_type: "po" | "ar" | "pre_advance"
      bank_direction: "credit" | "debit"
      bank_memo_class:
        | "remittance_wire"
        | "advance_funding"
        | "internal_transfer"
        | "unknown"
      bank_txn_status:
        | "unassigned"
        | "matched"
        | "batch_applied"
        | "remittance"
        | "ignored"
      cancellation_reason:
        | "shortage"
        | "quality"
        | "retailer_cancelled"
        | "client_request"
        | "other"
      client_deduction_source:
        | "promo_allowance"
        | "non_promo_receivable"
        | "netting_offset"
        | "chargeback"
        | "other"
      client_deduction_status: "accepted" | "disputed" | "upheld" | "reversed"
      client_status: "active" | "inactive" | "paused"
      deduction_category:
        | "shortage"
        | "damage"
        | "otif_fine"
        | "pricing"
        | "promotional"
        | "other"
      fee_target_type:
        | "advance"
        | "purchase_order"
        | "invoice"
        | "batch"
        | "client"
      ledger_event_type:
        | "advance_committed"
        | "advance_funded"
        | "fee_accrued"
        | "one_time_fee_assessed"
        | "payment_applied_to_principal"
        | "payment_applied_to_fee"
        | "payment_routed_to_remittance"
        | "remittance_wire_sent"
        | "advance_reversed"
        | "po_converted_to_ar"
        | "pre_advance_converted"
        | "balance_transferred_out"
        | "balance_transferred_in"
        | "advance_written_off"
        | "po_cancelled"
        | "po_cancellation_reversed"
      match_type: "strict" | "fuzzy" | "manual"
      payment_link_target: "invoice" | "batch"
      po_line_status:
        | "approved"
        | "received"
        | "partially_received"
        | "cancelled"
      po_status:
        | "active"
        | "partially_invoiced"
        | "fully_invoiced"
        | "cancelled"
        | "written_off"
        | "closed_awaiting_invoice"
      user_role:
        | "admin_manager"
        | "operator"
        | "client"
        | "investor"
        | "creditor"
      user_status: "active" | "disabled"
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
      advance_request_status: ["pending", "approved", "rejected", "fulfilled"],
      advance_status: [
        "committed",
        "funded",
        "paid_in_full",
        "transferred_out",
        "written_off",
        "reversed",
      ],
      advance_type: ["po", "ar", "pre_advance"],
      bank_direction: ["credit", "debit"],
      bank_memo_class: [
        "remittance_wire",
        "advance_funding",
        "internal_transfer",
        "unknown",
      ],
      bank_txn_status: [
        "unassigned",
        "matched",
        "batch_applied",
        "remittance",
        "ignored",
      ],
      cancellation_reason: [
        "shortage",
        "quality",
        "retailer_cancelled",
        "client_request",
        "other",
      ],
      client_deduction_source: [
        "promo_allowance",
        "non_promo_receivable",
        "netting_offset",
        "chargeback",
        "other",
      ],
      client_deduction_status: ["accepted", "disputed", "upheld", "reversed"],
      client_status: ["active", "inactive", "paused"],
      deduction_category: [
        "shortage",
        "damage",
        "otif_fine",
        "pricing",
        "promotional",
        "other",
      ],
      fee_target_type: [
        "advance",
        "purchase_order",
        "invoice",
        "batch",
        "client",
      ],
      ledger_event_type: [
        "advance_committed",
        "advance_funded",
        "fee_accrued",
        "one_time_fee_assessed",
        "payment_applied_to_principal",
        "payment_applied_to_fee",
        "payment_routed_to_remittance",
        "remittance_wire_sent",
        "advance_reversed",
        "po_converted_to_ar",
        "pre_advance_converted",
        "balance_transferred_out",
        "balance_transferred_in",
        "advance_written_off",
        "po_cancelled",
        "po_cancellation_reversed",
      ],
      match_type: ["strict", "fuzzy", "manual"],
      payment_link_target: ["invoice", "batch"],
      po_line_status: [
        "approved",
        "received",
        "partially_received",
        "cancelled",
      ],
      po_status: [
        "active",
        "partially_invoiced",
        "fully_invoiced",
        "cancelled",
        "written_off",
        "closed_awaiting_invoice",
      ],
      user_role: [
        "admin_manager",
        "operator",
        "client",
        "investor",
        "creditor",
      ],
      user_status: ["active", "disabled"],
    },
  },
} as const
