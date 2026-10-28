package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

// encode turns a numeric ID into a base62 string, e.g. 125 -> "21".
func encode(n int64) string {
	if n == 0 {
		return string(base62[0])
	}
	var buf []byte
	for n > 0 {
		buf = append([]byte{base62[n%62]}, buf...)
		n /= 62
	}
	return string(buf)
}

type server struct {
	db      *pgxpool.Pool
	baseURL string
}

type shortenRequest struct {
	URL string `json:"url"`
}

type shortenResponse struct {
	Code     string `json:"code"`
	ShortURL string `json:"short_url"`
}

func (s *server) shorten(w http.ResponseWriter, r *http.Request) {
	var req shortenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	u, err := url.ParseRequestURI(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		http.Error(w, "url must be a valid http(s) URL", http.StatusBadRequest)
		return
	}

	// Take the next ID from the DB sequence and encode it as the short code.
	// The sequence guarantees uniqueness, even across many app instances.
	var id int64
	if err := s.db.QueryRow(r.Context(), `SELECT nextval('urls_id_seq')`).Scan(&id); err != nil {
		log.Printf("nextval: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	code := encode(id)
	if _, err := s.db.Exec(r.Context(),
		`INSERT INTO urls (id, code, long_url) VALUES ($1, $2, $3)`, id, code, req.URL); err != nil {
		log.Printf("insert: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(shortenResponse{Code: code, ShortURL: s.baseURL + "/" + code})
}

func (s *server) redirect(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	var longURL string
	err := s.db.QueryRow(r.Context(), `SELECT long_url FROM urls WHERE code = $1`, code).Scan(&longURL)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// 302 (not 301) so browsers don't cache it and every hit reaches the server.
	http.Redirect(w, r, longURL, http.StatusFound)
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func connectDB(ctx context.Context, dsn string) *pgxpool.Pool {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatalf("bad DATABASE_URL: %v", err)
	}
	// Keep the pool small: Postgres allows ~100 connections total and we
	// will run many app replicas later.
	cfg.MaxConns = 10

	// Postgres may still be starting; retry for a while.
	for i := 0; i < 30; i++ {
		pool, err := pgxpool.NewWithConfig(ctx, cfg)
		if err == nil {
			if err = pool.Ping(ctx); err == nil {
				return pool
			}
			pool.Close()
		}
		log.Printf("waiting for database: %v", err)
		time.Sleep(time.Second)
	}
	log.Fatal("could not connect to database")
	return nil
}

func main() {
	ctx := context.Background()
	db := connectDB(ctx, getenv("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/urlshortener"))
	defer db.Close()

	// Idempotent, so safe when several replicas start at once.
	if _, err := db.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS urls (
			id       BIGSERIAL PRIMARY KEY,
			code     TEXT UNIQUE NOT NULL,
			long_url TEXT NOT NULL
		)`); err != nil {
		log.Fatalf("create table: %v", err)
	}

	s := &server{db: db, baseURL: getenv("BASE_URL", "http://localhost:8080")}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /shorten", s.shorten)
	mux.HandleFunc("GET /{code}", s.redirect)

	addr := ":" + getenv("PORT", "8080")
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
