sudo rm -R .git
git init
git add .        
git commit -m "first commit"
git branch -M main
git remote add origin git@github.com:AmmarBasha2011/my-restreamer.git
git push -u origin main --force
