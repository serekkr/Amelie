// amelie-smb — SMB2/3 helper per Amelie (sostituisce il binario di sistema
// `smbclient`). Un solo binario Go statico, ~3 MB, incorporato nell'AppImage:
// niente installazione, niente root, e SMB 3.1.1 con cifratura (go-smb2).
//
// Le CREDENZIALI arrivano da variabili d'ambiente (MAI su argv, così non finiscono
// in `ps`/`/proc`):
//   AMELIE_SMB_HOST, AMELIE_SMB_PORT(=445), AMELIE_SMB_SHARE,
//   AMELIE_SMB_USER, AMELIE_SMB_PASS, AMELIE_SMB_DOMAIN(=WORKGROUP)
//
// Sottocomandi (i path usano '/', convertiti in '\' internamente):
//   test                          verifica connessione+mount (exit 0/1)
//   list   <dir>                  JSON [{name,size,mtime,dir}]  (non ricorsivo)
//   listr  <dir>                  JSON [{path,size,mtime,dir}]  (ricorsivo)
//   stat   <remote>               JSON {exists,size,mtime,dir}
//   get    <remote> <local>       scarica (streaming)
//   put    <local>  <remote>      carica (crea le cartelle padre)
//   del    <remote>               elimina un file
//   deltree<remote>               elimina una cartella (ricorsivo)
//   mkdirp <remote>               crea cartella (ricorsivo)
//   rename <old> <new>            rinomina/sposta
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/hirochachacha/go-smb2"
)

func die(format string, a ...interface{}) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}

// go-smb2 stringifica gli NTSTATUS come PROSA ("The specified share name cannot
// be found…"), non come simbolo, quindi il chiamante non può classificarli in
// modo stabile dal testo. Estraiamo il codice dall'errore tipizzato ed emettiamo
// un token stabile `SMBERR:<NOME>` che il codice JS può abbinare.
var smbErrNames = map[uint32]string{
	0xC00000CC: "BAD_NETWORK_NAME",   // share inesistente
	0xC000006D: "LOGON_FAILURE",      // user/password errati
	0xC000006A: "WRONG_PASSWORD",
	0xC0000064: "NO_SUCH_USER",
	0xC000006E: "ACCOUNT_RESTRICTION",
	0xC0000072: "ACCOUNT_DISABLED",
	0xC0000234: "ACCOUNT_LOCKED_OUT",
	0xC0000071: "PASSWORD_EXPIRED",
	0xC0000022: "ACCESS_DENIED",
}

func smbErrToken(err error) string {
	var re *smb2.ResponseError
	if errors.As(err, &re) {
		if n := smbErrNames[re.Code]; n != "" {
			return n
		}
		return fmt.Sprintf("0x%08X", re.Code)
	}
	// conn.go rimappa alcuni status su errori sentinella os.*, perdendo il codice.
	if errors.Is(err, os.ErrPermission) {
		return "ACCESS_DENIED"
	}
	if errors.Is(err, os.ErrNotExist) {
		return "OBJECT_NOT_FOUND"
	}
	return ""
}

// dieErr: come die, ma aggiunge la riga stabile `SMBERR:<TOKEN>` quando l'errore
// porta un NTSTATUS riconoscibile.
func dieErr(prefix string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", prefix, err)
	if tok := smbErrToken(err); tok != "" {
		fmt.Fprintf(os.Stderr, "SMBERR:%s\n", tok)
	}
	os.Exit(1)
}

// SMB usa '\' come separatore; accettiamo '/' dal chiamante.
func toSmb(p string) string {
	p = strings.ReplaceAll(p, "/", "\\")
	p = strings.Trim(p, "\\")
	return p
}

type entry struct {
	Name  string `json:"name,omitempty"`
	Path  string `json:"path,omitempty"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"` // Unix millisecondi (compatibile con Date JS)
	Dir   bool   `json:"dir"`
}

func main() {
	if len(os.Args) < 2 {
		die("uso: amelie-smb <comando> [args]  (credenziali via env AMELIE_SMB_*)")
	}
	cmd := os.Args[1]
	args := os.Args[2:]

	host := os.Getenv("AMELIE_SMB_HOST")
	port := os.Getenv("AMELIE_SMB_PORT")
	if port == "" {
		port = "445"
	}
	share := os.Getenv("AMELIE_SMB_SHARE")
	user := os.Getenv("AMELIE_SMB_USER")
	pass := os.Getenv("AMELIE_SMB_PASS")
	domain := os.Getenv("AMELIE_SMB_DOMAIN")
	if domain == "" {
		domain = "WORKGROUP"
	}
	if host == "" || share == "" {
		die("mancano AMELIE_SMB_HOST / AMELIE_SMB_SHARE")
	}

	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, port), 20*time.Second)
	if err != nil {
		die("connessione fallita: %v", err)
	}
	defer conn.Close()

	d := &smb2.Dialer{Initiator: &smb2.NTLMInitiator{User: user, Password: pass, Domain: domain}}
	s, err := d.Dial(conn)
	if err != nil {
		dieErr("autenticazione/negoziazione fallita", err)
	}
	defer s.Logoff()

	fs, err := s.Mount(share)
	if err != nil {
		dieErr("mount della share fallito", err)
	}
	defer fs.Umount()

	switch cmd {
	case "test":
		os.Exit(0)

	case "list":
		if len(args) < 1 {
			die("uso: list <dir>")
		}
		infos, err := fs.ReadDir(toSmb(args[0]))
		if err != nil {
			die("list: %v", err)
		}
		out := []entry{}
		for _, fi := range infos {
			n := fi.Name()
			if n == "." || n == ".." || strings.Contains(n, ".amelie-tmp-") {
				continue
			}
			out = append(out, entry{Name: n, Size: fi.Size(), Mtime: fi.ModTime().UnixMilli(), Dir: fi.IsDir()})
		}
		emit(out)

	case "listr":
		if len(args) < 1 {
			die("uso: listr <dir>")
		}
		base := toSmb(args[0])
		out := []entry{}
		var walk func(rel string) // rel: sempre con '/', relativo a base
		walk = func(rel string) {
			// Attenzione: con base vuota (radice della share) NON anteporre '\' —
			// "\notes" verrebbe rifiutato dal server e la ricorsione morirebbe.
			relSmb := strings.ReplaceAll(rel, "/", "\\")
			var full string
			switch {
			case base == "":
				full = relSmb // "" alla radice, oppure il rel puro
			case rel == "":
				full = base
			default:
				full = base + "\\" + relSmb
			}
			infos, err := fs.ReadDir(full)
			if err != nil {
				return
			}
			for _, fi := range infos {
				n := fi.Name()
				if n == "." || n == ".." || strings.Contains(n, ".amelie-tmp-") {
					continue
				}
				childRel := n
				if rel != "" {
					childRel = rel + "/" + n
				}
				if fi.IsDir() {
					out = append(out, entry{Path: childRel, Mtime: fi.ModTime().UnixMilli(), Dir: true})
					walk(childRel)
				} else {
					out = append(out, entry{Path: childRel, Size: fi.Size(), Mtime: fi.ModTime().UnixMilli()})
				}
			}
		}
		walk("")
		emit(out)

	case "stat":
		if len(args) < 1 {
			die("uso: stat <remote>")
		}
		fi, err := fs.Stat(toSmb(args[0]))
		if err != nil {
			emit(map[string]interface{}{"exists": false})
			return
		}
		emit(map[string]interface{}{"exists": true, "size": fi.Size(), "mtime": fi.ModTime().UnixMilli(), "dir": fi.IsDir()})

	case "get":
		if len(args) < 2 {
			die("uso: get <remote> <local>")
		}
		rf, err := fs.Open(toSmb(args[0]))
		if err != nil {
			die("get open remoto: %v", err)
		}
		defer rf.Close()
		lf, err := os.Create(args[1])
		if err != nil {
			die("get create locale: %v", err)
		}
		defer lf.Close()
		if _, err := io.Copy(lf, rf); err != nil {
			die("get copia: %v", err)
		}

	case "putdir":
		// Carica RICORSIVAMENTE una cartella locale in una cartella remota, in UNA
		// sola sessione (per il backup: evita una connessione per file).
		if len(args) < 2 {
			die("uso: putdir <localDir> <remoteDir>")
		}
		localDir, remoteBase := args[0], toSmb(args[1])
		_ = fs.MkdirAll(remoteBase, 0755)
		var count int
		err := filepathWalk(localDir, func(abs, rel string, isDir bool) error {
			remote := remoteBase + "\\" + strings.ReplaceAll(rel, "/", "\\")
			if isDir {
				return fs.MkdirAll(remote, 0755)
			}
			lf, e := os.Open(abs)
			if e != nil {
				return e
			}
			defer lf.Close()
			rf, e := fs.Create(remote)
			if e != nil {
				return e
			}
			defer rf.Close()
			_, e = io.Copy(rf, lf)
			if e == nil {
				count++
			}
			return e
		})
		if err != nil {
			die("putdir: %v", err)
		}
		fmt.Printf("%d\n", count)

	case "put":
		if len(args) < 2 {
			die("uso: put <local> <remote>")
		}
		remote := toSmb(args[1])
		if dir := path.Dir(strings.ReplaceAll(remote, "\\", "/")); dir != "." && dir != "/" {
			_ = fs.MkdirAll(strings.ReplaceAll(dir, "/", "\\"), 0755)
		}
		// ATOMICO: scrivi su un nome temporaneo e poi rinomina sul finale, così un
		// lettore concorrente (es. un altro PC in sync realtime che scarica) non
		// vede mai un file scritto a metà. go-smb2's Rename NON sovrascrive un
		// target esistente → per un update rimuoviamo prima il vecchio (piccola
		// finestra "not-found", ritentata dalla sync).
		if err := atomicPut(fs, args[0], remote); err != nil {
			die("put: %v", err)
		}

	case "del":
		if len(args) < 1 {
			die("uso: del <remote>")
		}
		if err := fs.Remove(toSmb(args[0])); err != nil {
			die("del: %v", err)
		}

	case "deltree":
		if len(args) < 1 {
			die("uso: deltree <remote>")
		}
		if err := fs.RemoveAll(toSmb(args[0])); err != nil {
			die("deltree: %v", err)
		}

	case "mkdirp":
		if len(args) < 1 {
			die("uso: mkdirp <remote>")
		}
		if err := fs.MkdirAll(toSmb(args[0]), 0755); err != nil {
			die("mkdirp: %v", err)
		}

	case "rename":
		if len(args) < 2 {
			die("uso: rename <old> <new>")
		}
		if err := fs.Rename(toSmb(args[0]), toSmb(args[1])); err != nil {
			die("rename: %v", err)
		}

	default:
		die("comando sconosciuto: %s", cmd)
	}
}

// atomicPut carica localPath su remote scrivendo un file temporaneo accanto al
// finale e poi rinominandolo: un lettore concorrente (es. un altro PC in sync
// realtime che scarica) non vede MAI un file scritto a metà. go-smb2's Rename usa
// ReplaceIfExists=0 (non sovrascrive), quindi per un update rimuoviamo prima il
// vecchio target — una breve finestra "not-found" che la sync semplicemente ritenta.
func atomicPut(fs *smb2.Share, localPath, remote string) error {
	lf, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("open locale: %w", err)
	}
	defer lf.Close()
	tmp := remote + fmt.Sprintf(".amelie-tmp-%d-%d", os.Getpid(), time.Now().UnixNano())
	rf, err := fs.Create(tmp)
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	if _, err := io.Copy(rf, lf); err != nil {
		rf.Close()
		_ = fs.Remove(tmp)
		return fmt.Errorf("copia: %w", err)
	}
	rf.Close() // chiudi (flush) PRIMA del rename
	_ = fs.Remove(remote)
	if err := fs.Rename(tmp, remote); err != nil {
		_ = fs.Remove(tmp)
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// filepathWalk visita ricorsivamente root; rel è forward-slash relativo a root
// (la root stessa viene saltata).
func filepathWalk(root string, fn func(abs, rel string, isDir bool) error) error {
	return filepath.WalkDir(root, func(p string, de os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, e := filepath.Rel(root, p)
		if e != nil {
			return e
		}
		if rel == "." {
			return nil
		}
		return fn(p, filepath.ToSlash(rel), de.IsDir())
	})
}

func emit(v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		die("json: %v", err)
	}
	os.Stdout.Write(b)
	os.Stdout.Write([]byte("\n"))
}
