import sys
from search import search


def main():
    if len(sys.argv) < 2:
        print("usage: query.py <question>", file=sys.stderr)
        sys.exit(1)
    for r in search(" ".join(sys.argv[1:]), k=3):
        print(f"(p.{r['page']}) dist={r['distance']:.3f}")
        print(r["text"])
        print()


if __name__ == "__main__":
    main()
